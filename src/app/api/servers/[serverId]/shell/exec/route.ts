import { NextRequest, NextResponse } from 'next/server';
import { requireUserSession, requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { loadShellTarget, assertShellAccountSafe, runOnShellTarget } from '@/lib/ssh/shell-target';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * Run a command as the host's NON-ADMIN shell account (no sudo, no Docker group, no way to the
 * admin account). API keys only, and only with the `shell.user` permission; the web UI has no
 * use for it (its terminal asks for the person's own login). The privileged account is never used.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.authType !== 'api_key') {
    // A signed-in person can use the web terminal with their own login instead.
    const s = await requireUserSession(request);
    if (s instanceof NextResponse) return s;
    return fail('Shell commands as the non-admin account are for API keys only; use the terminal with your own login', 403, 'API_KEY_REQUIRED');
  }
  const { serverId } = await params;
  const denied = await requirePermission(auth, 'shell.user', serverId);
  if (denied) return denied;

  let body: { command?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return fail('Command required');
  if (command.length > 4000) return fail('Command too long');
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many commands, slow down', 429, 'RATE_LIMITED');

  const started = Date.now();
  try {
    const target = await loadShellTarget(serverId);
    await assertShellAccountSafe(target);
    const r = await runOnShellTarget(target, command, { timeoutMs: 60_000 });
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.SERVER_SHELL_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
      details: `${target.config.username}: ${command.slice(0, 500)}`, durationMs: Date.now() - started });
    return ok({ output: r.stdout.slice(0, 256 * 1024), error: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut, account: target.config.username });
  } catch (error) {
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.SERVER_SHELL_EXEC, status: 'failure',
      details: `refused or failed: ${String(error).slice(0, 200)}`, durationMs: Date.now() - started }).catch(() => undefined);
    return failFrom(error);
  }
}
