/**
 * Issuing the single-use token for an API terminal (`/ws/api-terminal`). Shared by
 * `POST /api/servers/:id/terminal` and by package widgets' terminal actions, which differ only in
 * which permission the caller needed (checked by the route before calling this).
 */
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { authSecret } from '@/lib/auth/jwt';
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { TOKEN_TYPE, LIMIT_KEYS, terminalLimits } from '@/lib/terminal/api-terminal';

/**
 * Rate limit, check the server can offer that kind of terminal, and mint the token. `auth` must be an
 * API key that has already been authorised for the target. `via` names what asked (for the audit entry).
 */
export async function issueApiTerminalToken(
  auth: TokenPayload, serverId: string, target: 'host' | 'container', container: string, via?: string,
): Promise<NextResponse> {
  if (auth.authType !== 'api_key' || !auth.apiKeyId) {
    return fail('API terminals are for API keys only; the web terminal asks for your own login', 403, 'API_KEY_REQUIRED');
  }
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many requests, slow down', 429, 'RATE_LIMITED');

  try {
    const r = await rqlite.query('SELECT platform, shell_user, shell_key_id, ssh_key_id FROM servers WHERE id = ?', [serverId]);
    const row = r.values?.[0];
    if (!row) return fail('Server not found', 404);
    const [platform, shellUser, shellKeyId, sshKeyId] = row as (string | null)[];
    if (platform === 'windows' && target === 'container') return fail('Container shells are not available on Windows hosts', 409, 'SHELL_UNAVAILABLE');
    if (target === 'host' && !(shellUser && shellKeyId)) return fail('This server has no non-admin shell account. Provision it again (Add Server) to create one.', 409, 'SHELL_UNAVAILABLE');
    if (target === 'container' && !sshKeyId) return fail('No SSH key assigned to this server', 409, 'SHELL_UNAVAILABLE');

    const tokenTtlSec = terminalLimits({ [LIMIT_KEYS.tokenTtlSec]: await getConfig(LIMIT_KEYS.tokenTtlSec) }).tokenTtlSec;
    const token = await new SignJWT({
      userId: auth.userId, username: auth.username, authType: 'api_key', apiKeyId: auth.apiKeyId,
      type: TOKEN_TYPE, serverId, target, ...(target === 'container' ? { container } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${tokenTtlSec}s`)
      .sign(authSecret());

    await logAudit({ userId: auth.userId, serverId, action: AuditActions.TERMINAL_API_TOKEN, status: 'success',
      details: `${target === 'host' ? 'host shell' : `container ${container}`}${via ? ` (via ${via})` : ''}` });
    return ok({ token, expiresInSec: tokenTtlSec, path: '/ws/api-terminal', target, container: container || null });
  } catch (error) {
    return failFrom(error);
  }
}
