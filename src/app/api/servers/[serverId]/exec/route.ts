import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * Run an ad-hoc command as the server's service account (custom command
 * widget). Operator or admin; rate limited and audited. Windows hosts run it
 * as PowerShell.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'operator');
  if (roleError) return roleError;
  const { serverId } = await params;

  let body: { command?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return fail('Command required');
  if (command.length > 4000) return fail('Command too long');
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many commands, slow down', 429, 'RATE_LIMITED');

  const started = Date.now();
  try {
    const r = await runOnServerId(serverId, command, { timeoutMs: 60_000 });
    await logAudit({ userId: auth.userId, serverId, action: 'server.exec', status: r.exitCode === 0 ? 'success' : 'failure',
      details: command.slice(0, 500), durationMs: Date.now() - started });
    return ok({ output: r.stdout.slice(0, 256 * 1024), error: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut });
  } catch (error) {
    return failFrom(error);
  }
}
