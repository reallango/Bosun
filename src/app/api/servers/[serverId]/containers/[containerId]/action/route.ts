import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { containerAction, isContainerAction, assertContainerRef, requestPoll } from '@/lib/docker/actions';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * Start / stop / restart a container. Read + actions (operator) or higher, requires an explicit
 * `confirm: true`, rate limited and audited.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string; containerId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, containerId } = await params;
  const roleError = await requirePermission(auth, 'docker.containers.control', serverId);
  if (roleError) return roleError;

  let body: { action?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const action = body.action;
  if (!isContainerAction(action)) return fail('action must be start, stop or restart');
  if (body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
  try { assertContainerRef(containerId); } catch (e) { return failFrom(e); }
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');

  const started = Date.now();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0];
  try {
    const result = await containerAction(serverId, containerId, action);
    await logAudit({
      userId: auth.userId, serverId, action: AuditActions.CONTAINER_ACTION, status: result.success ? 'success' : 'failure',
      details: JSON.stringify({ container: containerId, action, output: result.output.slice(0, 300) }),
      durationMs: Date.now() - started, ipAddress: ip,
    });
    await requestPoll(serverId);
    if (!result.success) return fail(result.output || `docker ${action} failed (exit ${result.exitCode})`, 502, 'ACTION_FAILED');
    return ok({ success: true, output: result.output });
  } catch (error) {
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.CONTAINER_ACTION, status: 'failure',
      details: JSON.stringify({ container: containerId, action, error: String(error).slice(0, 300) }), ipAddress: ip });
    return failFrom(error);
  }
}
