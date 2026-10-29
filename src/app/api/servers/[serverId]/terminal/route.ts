import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { SignJWT } from 'jose';
import { authSecret } from '@/lib/auth/jwt';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { rqlite } from '@/lib/db/rqlite-client';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { TOKEN_TYPE, TOKEN_TTL_SEC, CONTAINER_REF_RE } from '@/lib/terminal/api-terminal';

/**
 * Mint a single-use, 60-second token for the API terminal WebSocket (`/ws/api-terminal`).
 * API keys only. Two targets, each with its own permission, so a container shell can be
 * granted without any host shell:
 *   { target: 'host' }                      needs `shell.user`   (the non-admin account)
 *   { target: 'container', container: ... } needs `docker.shell` (docker exec into one container)
 * The web terminal is separate: it asks for the person's own login and never uses this token.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.authType !== 'api_key' || !auth.apiKeyId) {
    return fail('API terminals are for API keys only; the web terminal asks for your own login', 403, 'API_KEY_REQUIRED');
  }
  const { serverId } = await params;

  let body: { target?: unknown; container?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const target = body.target;
  if (target !== 'host' && target !== 'container') return fail('target must be "host" or "container"');
  const container = typeof body.container === 'string' ? body.container.trim() : '';
  if (target === 'container' && !CONTAINER_REF_RE.test(container)) return fail('container must be a container name or id');
  if (target === 'host' && container) return fail('container is only valid with target "container"');

  const denied = await requirePermission(auth, target === 'host' ? 'shell.user' : 'docker.shell', serverId);
  if (denied) return denied;

  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many requests, slow down', 429, 'RATE_LIMITED');

  try {
    const r = await rqlite.query('SELECT platform, shell_user, shell_key_id, ssh_key_id FROM servers WHERE id = ?', [serverId]);
    const row = r.values?.[0];
    if (!row) return fail('Server not found', 404);
    const [platform, shellUser, shellKeyId, sshKeyId] = row as (string | null)[];
    if (platform === 'windows') return fail('API terminals are not available on Windows hosts yet', 409, 'SHELL_UNAVAILABLE');
    if (target === 'host' && !(shellUser && shellKeyId)) return fail('This server has no non-admin shell account. Provision it again (Add Server) to create one.', 409, 'SHELL_UNAVAILABLE');
    if (target === 'container' && !sshKeyId) return fail('No SSH key assigned to this server', 409, 'SHELL_UNAVAILABLE');

    const token = await new SignJWT({
      userId: auth.userId, username: auth.username, authType: 'api_key', apiKeyId: auth.apiKeyId,
      type: TOKEN_TYPE, serverId, target, ...(target === 'container' ? { container } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SEC}s`)
      .sign(authSecret());

    await logAudit({ userId: auth.userId, serverId, action: AuditActions.TERMINAL_API_TOKEN, status: 'success',
      details: target === 'host' ? 'host shell' : `container ${container}` });
    return ok({ token, expiresInSec: TOKEN_TTL_SEC, path: '/ws/api-terminal', target, container: container || null });
  } catch (error) {
    return failFrom(error);
  }
}
