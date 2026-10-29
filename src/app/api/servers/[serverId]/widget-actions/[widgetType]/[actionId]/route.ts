import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec, runAction, RuntimeError } from '@/lib/widgets/runtime/execute';
import { ParamError } from '@/lib/widgets/runtime/command';

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

    let body: { params?: unknown; confirm?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    if (action.confirm && body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
    const limit = consumeActionRateLimit(auth.userId);
    if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');

    const started = Date.now();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0];
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
