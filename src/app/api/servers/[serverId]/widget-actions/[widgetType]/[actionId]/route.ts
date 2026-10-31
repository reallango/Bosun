import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec, runAction, runScript, prepareScriptAction, loadInstance, RuntimeError } from '@/lib/widgets/runtime/execute';
import { startJob } from '@/lib/widgets/jobs/runtime';
import { rqlite } from '@/lib/db/rqlite-client';
import { storeActionData } from '@/lib/widgets/runtime/store-data';
import { ParamError } from '@/lib/widgets/runtime/command';
import { CONTAINER_REF_RE } from '@/lib/terminal/api-terminal';
import { issueApiTerminalToken } from '@/lib/terminal/api-token';

/**
 * Run one action of a package widget: POST /api/servers/:serverId/widget-actions/:widgetType/:actionId
 * with { params: {...}, confirm: true }. This is the same call the widget's buttons make, so an API
 * key can do exactly what the widget does, no more: the action's own permission (declared by the
 * package and granted through permission groups) is required, parameters are validated against the
 * action's declaration, and `confirm: true` is required for actions that ask for confirmation.
 * See /api/openapi.json for every action with its parameters.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string; widgetType: string; actionId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, widgetType, actionId } = await params;

  try {
    const loaded = await loadWidgetSpec(widgetType);
    const action = loaded?.spec.actions.find(a => a.id === actionId);
    if (!loaded || !action) return fail('Unknown widget action', 404, 'NOT_FOUND');
    const denied = await requirePermission(auth, action.permission, serverId);
    if (denied) return denied;

    let body: { params?: unknown; confirm?: unknown; container?: unknown; widgetId?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    // A terminal action: for API keys it hands out the token for an API terminal in that container (the same
    // single-use WebSocket, with the same checks that refuse containers able to reach the host), gated by the
    // permission this action names instead of the built-in docker.shell. The web UI uses the web terminal instead.
    if (action.kind === 'terminal') {
      const container = typeof body.container === 'string' ? body.container.trim() : '';
      if (!CONTAINER_REF_RE.test(container)) return fail('container must be a container name or id');
      return issueApiTerminalToken(auth, serverId, 'container', container, `${widgetType}/${actionId}`);
    }
    if (action.confirm && body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
    const limit = consumeActionRateLimit(auth.userId);
    if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');

    const started = Date.now();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0];

    // Version 2 script action: the variant that applies to this host runs its package script. With `job: true` it runs
    // in the background (answers 202 with the job to follow), otherwise the answer comes when the script ends.
    if (action.kind === 'script') {
      try {
        const instance = await loadInstance(serverId, widgetType, body.widgetId);
        const prepared = await prepareScriptAction(serverId, loaded, action, body.params, instance);
        if (action.job) {
          const { job } = await startJob({ serverId, loaded, action, prepared, userId: auth.userId, params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>, instanceId: instance?.id, ip });
          await logAudit({
            userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'success',
            details: JSON.stringify({ widget: widgetType, action: actionId, job: job.id, started: true, params: body.params ?? {} }).slice(0, 900), ipAddress: ip,
          });
          return ok({ jobId: job.id, status: job.status }, { status: 202 });
        }
        const r = await runScript(serverId, loaded, prepared.scriptId, prepared.args);
        if (r.success && !r.protocol.error && action.stores === 'data') await storeActionData(serverId, loaded.type, loaded.spec.data, instance?.id, r.stdout);
        // The action changed something on the host: have the poller look again now (state and data), not at its next period.
        if (r.success && !r.protocol.error && action.after === 'refresh') await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), serverId]).catch(() => undefined);
        await logAudit({
          userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: r.success ? 'success' : 'failure',
          details: JSON.stringify({ widget: widgetType, action: actionId, as: action.as, params: body.params ?? {}, exitCode: r.exitCode, output: r.stdout.slice(0, 200) }).slice(0, 900),
          durationMs: Date.now() - started, ipAddress: ip,
        });
        return ok({ success: r.success && !r.protocol.error, output: r.stdout, error: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, message: r.protocol.done ?? r.protocol.error });
      } catch (error) {
        await logAudit({
          userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'failure',
          details: JSON.stringify({ widget: widgetType, action: actionId, params: body.params ?? {}, error: String(error).slice(0, 300) }).slice(0, 900), ipAddress: ip,
        });
        if (error instanceof ParamError) return fail(error.message, 400, 'INVALID_PARAMS');
        throw error;
      }
    }
    try {
      const r = await runAction(serverId, action, body.params);
      await logAudit({
        userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: r.success ? 'success' : 'failure',
        details: JSON.stringify({ widget: widgetType, action: actionId, as: action.as, params: body.params ?? {}, exitCode: r.exitCode, output: r.stdout.slice(0, 200) }).slice(0, 900),
        durationMs: Date.now() - started, ipAddress: ip,
      });
      return ok({ success: r.success, output: r.stdout, error: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut });
    } catch (error) {
      await logAudit({
        userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'failure',
        details: JSON.stringify({ widget: widgetType, action: actionId, params: body.params ?? {}, error: String(error).slice(0, 300) }).slice(0, 900), ipAddress: ip,
      });
      if (error instanceof ParamError) return fail(error.message, 400, 'INVALID_PARAMS');
      throw error;
    }
  } catch (error) {
    if (error instanceof RuntimeError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
