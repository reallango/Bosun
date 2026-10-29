import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { fail } from '@/lib/api/response';
import { CONTAINER_REF_RE } from '@/lib/terminal/api-terminal';
import { issueApiTerminalToken } from '@/lib/terminal/api-token';

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

  return issueApiTerminalToken(auth, serverId, target, container);
}
