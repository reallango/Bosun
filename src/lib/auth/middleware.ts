import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, TokenPayload } from './jwt';
import { bearerToken } from './api-keys';
import { authenticateApiKey } from './api-key-auth';
import { getUserStatus } from './user-status';
import { ACCESS_LEVELS, hasRole, type Role } from './levels';
import { serverVisible } from '@/lib/permissions/effective';

function authError(message: string, code: string, status = 401, headers?: HeadersInit) {
  return NextResponse.json({ data: null, error: { message, code } }, { status, headers });
}

export function clientIp(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
}

/**
 * Authenticate a browser session: the `access_token` cookie. Disabled or
 * deleted users are refused, and the role comes from the database (cached
 * ~30 s), so role changes and disabling apply quickly.
 */
async function sessionAuth(request: NextRequest): Promise<TokenPayload | NextResponse> {
  const accessToken = request.cookies.get('access_token')?.value;
  if (!accessToken) return authError('Not authenticated', 'NOT_AUTHENTICATED');

  const payload = await verifyAccessToken(accessToken);
  if (!payload) return authError('Invalid or expired token', 'TOKEN_EXPIRED');
  // A session JWT never carries these; refuse anything that claims otherwise.
  if (payload.authType === 'api_key' || String(payload.userId).startsWith('apikey:')) {
    return authError('Invalid token', 'TOKEN_EXPIRED');
  }

  const status = await getUserStatus(String(payload.userId));
  if (status === null) return authError('Account no longer exists', 'ACCOUNT_DELETED');
  if (status?.disabled) return authError('Account is disabled', 'ACCOUNT_DISABLED');
  return { ...payload, role: status?.role ?? payload.role, authType: 'session' };
}

/**
 * Authenticate an API request: either `Authorization: Bearer bosun_...`
 * (API key) or the `access_token` session cookie. API keys yield
 * `{ userId: 'apikey:<id>', username: <key name>, role, authType: 'api_key', apiKeyId }`.
 */
export async function requireAuth(request: NextRequest): Promise<TokenPayload | NextResponse> {
  const bearer = bearerToken(request.headers.get('authorization'));
  if (bearer) {
    const result = await authenticateApiKey(bearer, clientIp(request));
    if (!result.ok) {
      const headers = result.retryAfterMs ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : undefined;
      return authError(result.message, result.code, result.status, headers);
    }
    return (await hiddenServerResponse(request, result.payload)) ?? result.payload;
  }
  const session = await sessionAuth(request);
  if (session instanceof NextResponse) return session;
  return (await hiddenServerResponse(request, session)) ?? session;
}

const SERVER_PATH_RE = /^\/api\/servers\/([^/]+)(?:\/|$)/;

/**
 * A server that a permission group hides from the caller (`servers.view` denied) does not exist as
 * far as that caller can tell: every route under /api/servers/:id answers 404. Full access is never hidden anything.
 */
async function hiddenServerResponse(request: NextRequest, payload: TokenPayload): Promise<NextResponse | null> {
  const m = SERVER_PATH_RE.exec(request.nextUrl.pathname);
  if (!m || payload.role === 'admin') return null;
  try {
    if (await serverVisible(payload, decodeURIComponent(m[1]))) return null;
  } catch (err) {
    console.error('Checking server visibility failed:', err);
    return authError('Could not check access right now', 'AUTH_UNAVAILABLE', 503);
  }
  return authError('Server not found', 'NOT_FOUND', 404);
}

/**
 * Like requireAuth, but only for a signed-in user (browser session). API keys
 * are refused: user and API key management, terminal tokens and anything
 * that creates sessions.
 */
export async function requireUserSession(request: NextRequest): Promise<TokenPayload | NextResponse> {
  if (bearerToken(request.headers.get('authorization'))) {
    return authError('API keys cannot be used for this endpoint; sign in to the web UI instead', 'API_KEY_NOT_ALLOWED', 403);
  }
  const session = await sessionAuth(request);
  if (session instanceof NextResponse) return session;
  return (await hiddenServerResponse(request, session)) ?? session;
}

export function requireRole(payload: TokenPayload, requiredRole: Role): NextResponse | null {
  if (!hasRole(payload.role, requiredRole)) {
    return authError(
      `Insufficient permissions: requires "${ACCESS_LEVELS[requiredRole].label}" access`,
      'FORBIDDEN',
      403,
    );
  }
  return null;
}

/** requireAuth + requireRole in one call. */
export async function requireLevel(request: NextRequest, requiredRole: Role): Promise<TokenPayload | NextResponse> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  return requireRole(auth, requiredRole) ?? auth;
}

/** requireUserSession + requireRole in one call. */
export async function requireUserLevel(request: NextRequest, requiredRole: Role): Promise<TokenPayload | NextResponse> {
  const auth = await requireUserSession(request);
  if (auth instanceof NextResponse) return auth;
  return requireRole(auth, requiredRole) ?? auth;
}
