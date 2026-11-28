/**
 * Run a widget action once its permission is settled: by the widget-actions route (the caller holds the permission), or
 * for an approved one-time access request (the approver decided). Validates the parameters, runs the script or command
 * (or starts its job) and writes the audit entry. Answers like the route.
 */
import { NextResponse } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail } from '@/lib/api/response';
import { runAction, runScript, prepareScriptAction, loadInstance, type LoadedSpec } from '@/lib/widgets/runtime/execute';
import type { ActionSpec } from '@/lib/widgets/runtime/spec';
import { startJob } from '@/lib/widgets/jobs/runtime';
import { rqlite } from '@/lib/db/rqlite-client';
import { storeActionData } from '@/lib/widgets/runtime/store-data';
import { ParamError } from '@/lib/widgets/runtime/command';
import { decryptOrigin, editorFieldsOf, encryptOrigin, maskValues, resolveTokens, sanitizeOrigin } from '@/lib/widgets/jobs/origin';
import { getJob, getOriginEnc, redactParams } from '@/lib/widgets/jobs/store';

export interface ActionBody { params?: unknown; confirm?: unknown; ref?: unknown; widgetId?: unknown; origin?: unknown; savedFrom?: unknown }

export async function runWidgetAction(
  auth: TokenPayload, serverId: string, loaded: LoadedSpec, action: ActionSpec, body: ActionBody,
  opts: { ip?: string; approvedBy?: string; requestId?: string } = {},
): Promise<NextResponse> {
  const widgetType = loaded.type;
  const actionId = action.id;
  const started = Date.now();
    // What the audit log records: before saved secrets are put back, with text and secret-looking values masked.
    const auditParams = redactParams(body.params);
    const ip = opts.ip;

    // Version 2 script action: the variant that applies to this host runs its package script. With `job: true` it runs
    // in the background (answers 202 with the job to follow), otherwise the answer comes when the script ends.
    if (action.kind === 'script') {
      try {
        // A screen reopened from a job: the placeholders of its saved secrets are replaced by the real values here, on the server.
        let savedSecrets: string[] = [];
        if (typeof body.savedFrom === 'string') {
          const old = await getJob(body.savedFrom);
          const oldOrigin = old && old.widgetType === widgetType && old.serverId === serverId && (old.userId === auth.userId || auth.role === 'admin') ? decryptOrigin(await getOriginEnc(old.id)) : null;
          if (!oldOrigin) return fail('The saved values of that task are no longer available: fill the screen in again.', 409, 'SAVED_GONE');
          savedSecrets = oldOrigin.secrets;
        }
        try {
          if (savedSecrets.length) { body.params = resolveTokens(body.params, savedSecrets); if (body.origin) body.origin = resolveTokens(body.origin, savedSecrets); }
        } catch (e) { return fail(e instanceof Error ? e.message : 'A saved value is no longer available', 409, 'SAVED_GONE'); }
        const instance = await loadInstance(serverId, widgetType, body.widgetId);
        const prepared = await prepareScriptAction(serverId, loaded, action, body.params, instance);
        if (action.job) {
          // Keep where it came from, with the secrets taken out and encrypted, so the screen can be reopened to correct it.
          let originEnc: string | null = null;
          let scrub: string[] = [];
          const origin = sanitizeOrigin(body.origin);
          if (origin && instance) {
            const masked = maskValues(editorFieldsOf(loaded.spec.screens?.[origin.screenId]), origin.values);
            scrub = masked.secrets;
            originEnc = encryptOrigin({ screenId: origin.screenId, context: origin.context, values: masked.values, secrets: masked.secrets });
          }
          const { job } = await startJob({ serverId, loaded, action, prepared, userId: auth.userId, params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>, instanceId: instance?.id, ip, originEnc, scrub });
          await logAudit({
            userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'success',
            details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), job: job.id, started: true, params: auditParams }).slice(0, 900), ipAddress: ip,
          });
          return ok({ jobId: job.id, status: job.status }, { status: 202 });
        }
        if (prepared.before) {
          const b = await runScript(serverId, loaded, prepared.before.scriptId, prepared.before.args, { credentials: prepared.before.credentials });
          if (!b.success || b.protocol.error) {
            const message = b.protocol.error || b.stderr.trim().split('\n').pop() || 'The script that must run first failed';
            await logAudit({
              userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'failure',
              details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), params: auditParams, before: prepared.before.scriptId, error: message.slice(0, 300) }).slice(0, 900), ipAddress: ip,
            });
            return fail(`The action did not run because "${prepared.before.scriptId}" failed: ${message}`, 500, 'BEFORE_FAILED');
          }
        }
        const r = await runScript(serverId, loaded, prepared.scriptId, prepared.args, { credentials: prepared.credentials });
        if (r.success && !r.protocol.error && action.stores === 'data') await storeActionData(serverId, loaded.type, loaded.spec.data, instance?.id, r.stdout);
        // The action changed something on the host: have the poller look again now (state and data), not at its next period.
        if (r.success && !r.protocol.error && action.after === 'refresh') await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), serverId]).catch(() => undefined);
        await logAudit({
          userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: r.success ? 'success' : 'failure',
          details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), as: action.as, params: auditParams, exitCode: r.exitCode, output: r.stdout.slice(0, 200) }).slice(0, 900),
          durationMs: Date.now() - started, ipAddress: ip,
        });
        return ok({ success: r.success && !r.protocol.error, output: r.stdout, error: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, message: r.protocol.done ?? r.protocol.error });
      } catch (error) {
        await logAudit({
          userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'failure',
          details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), params: auditParams, error: String(error).slice(0, 300) }).slice(0, 900), ipAddress: ip,
        });
        if (error instanceof ParamError) return fail(error.message, 400, 'INVALID_PARAMS');
        throw error;
      }
    }
    try {
      const r = await runAction(serverId, action, body.params);
      await logAudit({
        userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: r.success ? 'success' : 'failure',
        details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), as: action.as, params: auditParams, exitCode: r.exitCode, output: r.stdout.slice(0, 200) }).slice(0, 900),
        durationMs: Date.now() - started, ipAddress: ip,
      });
      return ok({ success: r.success, output: r.stdout, error: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut });
    } catch (error) {
      await logAudit({
        userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: 'failure',
        details: JSON.stringify({ widget: widgetType, action: actionId, ...(opts.approvedBy ? { approved_by: opts.approvedBy, request: opts.requestId } : {}), params: auditParams, error: String(error).slice(0, 300) }).slice(0, 900), ipAddress: ip,
      });
      if (error instanceof ParamError) return fail(error.message, 400, 'INVALID_PARAMS');
      throw error;
    }
}