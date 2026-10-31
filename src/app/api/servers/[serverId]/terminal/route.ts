import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { fail } from '@/lib/api/response';
import { issueApiTerminalToken } from '@/lib/terminal/api-token';

/**
 * Mint a single-use, 60-second token for the API terminal WebSocket (`/ws/api-terminal`) of the host shell.
 * API keys only; it needs `shell.user` and opens the host's non-admin account. (Terminals that a widget package
 * offers, such as a shell in a container, are opened through that package's own terminal action instead, see
 * `/api/servers/:id/widget-actions/...`.) The web terminal is separate: it asks for the person's own login and never
 * uses this token.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.authType !== 'api_key' || !auth.apiKeyId) {
    return fail('API terminals are for API keys only; the web terminal asks for your own login', 403, 'API_KEY_REQUIRED');
  }
  const { serverId } = await params;

  let body: { target?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.target !== 'host') return fail('target must be "host"; terminals of widget packages are opened through their terminal action');

  const denied = await requirePermission(auth, 'shell.user', serverId);
  if (denied) return denied;

  return issueApiTerminalToken(auth, serverId, 'host');
}
