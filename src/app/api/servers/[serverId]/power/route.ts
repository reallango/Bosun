import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { rqlite } from '@/lib/db/rqlite-client';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { isPowerAction, powerCommand, NO_SUDO_MARKER } from '@/lib/ssh/power';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * Shut down or restart a server over SSH. Needs the `power.shutdown` or `power.restart`
 * permission for this server (Read + actions holds both by default). Requires an
 * explicit `confirm: true`, rate limited and audited.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;

  let body: { action?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const action = body.action;
  if (!isPowerAction(action)) return fail('action must be shutdown or restart');
  const roleError = await requirePermission(auth, action === 'shutdown' ? 'power.shutdown' : 'power.restart', serverId);
  if (roleError) return roleError;
  if (body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');

  const started = Date.now();
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0];
  const audit = (status: 'success' | 'failure', extra: Record<string, unknown> = {}) => logAudit({
    userId: auth.userId, serverId, action: AuditActions.SERVER_POWER, status,
    details: JSON.stringify({ action, ...extra }), durationMs: Date.now() - started, ipAddress: ip,
  });

  try {
    const srv = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
    if (!srv.values?.length) return fail('Server not found', 404, 'NOT_FOUND');
    // runOnServerId wraps the command in PowerShell for Windows hosts.
    const platform = srv.values[0][0] === 'windows' ? 'windows' : 'linux';
    const r = await runOnServerId(serverId, powerCommand(platform, action), { timeoutMs: 20_000 });

    if (r.stdout.includes(NO_SUDO_MARKER)) {
      await audit('failure', { error: 'passwordless sudo required' });
      return fail('Passwordless sudo is required for the SSH user', 412, 'SUDO_REQUIRED');
    }
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout).trim().slice(0, 300);
      await audit('failure', { exitCode: r.exitCode, error: detail });
      return fail(detail || `${action} failed (exit ${r.exitCode})`, 502, 'ACTION_FAILED');
    }
    await audit('success');
    return ok({ success: true, action });
  } catch (error) {
    await audit('failure', { error: String(error).slice(0, 300) });
    return failFrom(error);
  }
}
