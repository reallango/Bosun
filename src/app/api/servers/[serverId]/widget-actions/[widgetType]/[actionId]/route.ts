import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec, RuntimeError } from '@/lib/widgets/runtime/execute';
import { openTerminalAction } from '@/lib/widgets/runtime/terminal-action';
import { resolveTarget, TargetError } from '@/lib/widgets/runtime/resource-check';
import { runWidgetAction, type ActionBody } from '@/lib/widgets/runtime/run-action';
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
    // An action that names its stack or container (action.target) is checked against that exact one once the request
    // has been read, so a grant limited to some stacks or containers works; any other action needs the permission for
    // the whole server.
    if (!action.target) {
      const denied = await requirePermission(auth, action.permission, serverId);
      if (denied) return denied;
    }

    let body: ActionBody;
    try { body = await request.json(); } catch { body = {}; }
    if (action.target) {
      const value = action.kind === 'terminal' ? body.ref : (body.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>)[action.target.param] : undefined);
      let resource;
      try { resource = await resolveTarget(serverId, loaded, action.target, value); } catch (e) {
        if (e instanceof TargetError) return fail(e.message, e.status, e.code);
        throw e;
      }
      const denied = await requirePermission(auth, action.permission, serverId, resource);
      if (denied) return denied;
    }
    // A terminal action runs one command the package declared in an interactive terminal: API keys get a token for an
    // API terminal (after the action's check), a signed-in Full access user a token for the web terminal. The target is
    // `ref`; see lib/widgets/runtime/terminal-action.ts.
    if (action.kind === 'screen') return fail('This action only opens a screen in the web UI', 400, 'NOT_RUNNABLE');
    if (action.kind === 'terminal') {
      return openTerminalAction(auth, serverId, loaded, action, typeof body.ref === 'string' ? body.ref.trim() : '');
    }
    if (action.confirm && body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
    const limit = consumeActionRateLimit(auth.userId);
    if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');

    return await runWidgetAction(auth, serverId, loaded, action, body, { ip: clientIp(request) ?? undefined });
  } catch (error) {
    if (error instanceof RuntimeError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
