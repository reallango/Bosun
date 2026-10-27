/**
 * Cookie sessions for the auth routes: user lookup, session creation (shared
 * by password login, MFA step 2 and password reset) and the "signed-in user
 * via cookie only" guard used by the account routes (API keys never reach
 * them, since only the access_token cookie is read).
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { createAccessToken, generateRefreshToken, hashToken, verifyAccessToken } from '@/lib/auth/jwt';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail } from '@/lib/api/response';

export const ACCESS_MAX_AGE = 15 * 60;
export const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  email: string | null;
  display_name: string | null;
  password_hash: string;
  disabled: number;
  mfa_method: 'none' | 'totp' | 'email';
  totp_secret: string | null;
  totp_enabled: number;
  mfa_backup_codes: string | null;
  password_changed_at: string | null;
}

const USER_COLUMNS = 'id, username, role, email, display_name, password_hash, disabled, mfa_method, totp_secret, totp_enabled, mfa_backup_codes, password_changed_at';

function toUser(row: Record<string, unknown> | undefined): AuthUser | null {
  if (!row) return null;
  const method = String(row.mfa_method || 'none');
  return {
    ...(row as unknown as AuthUser),
    disabled: Number(row.disabled) || 0,
    totp_enabled: Number(row.totp_enabled) || 0,
    mfa_method: (['totp', 'email'].includes(method) ? method : 'none') as AuthUser['mfa_method'],
  };
}

export async function findUserById(id: string): Promise<AuthUser | null> {
  return toUser(rowsToObjects(await rqlite.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]))[0]);
}

export async function findUserByUsername(username: string): Promise<AuthUser | null> {
  return toUser(rowsToObjects(await rqlite.query(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`, [username]))[0]);
}

/** Only when exactly one account uses the address (emails are not unique). */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = rowsToObjects(await rqlite.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?) LIMIT 2`, [email]));
  return rows.length === 1 ? toUser(rows[0]) : null;
}

export function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'strict' as const, path: '/', maxAge };
}

export function setAccessCookie(response: NextResponse, token: string) {
  response.cookies.set('access_token', token, cookieOptions(ACCESS_MAX_AGE));
}

/**
 * Create a session for a fully authenticated user (sessions row, access and
 * refresh cookies, last_login, audit) and answer with the user.
 */
export async function startSession(request: NextRequest, user: Pick<AuthUser, 'id' | 'username' | 'role'>, auditDetails?: string): Promise<NextResponse> {
  const ip = clientIp(request);
  const accessToken = await createAccessToken(user.id, user.username, user.role);
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE * 1000).toISOString();
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 255) || null;
  await rqlite.execute(
    'INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), user.id, hashToken(refreshToken), ip, userAgent, expiresAt]);
  await rqlite.execute('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  await logAudit({ userId: user.id, action: AuditActions.LOGIN, status: 'success', ipAddress: ip, details: auditDetails });
  const response = NextResponse.json({ data: { user: { id: user.id, username: user.username, role: user.role } } });
  setAccessCookie(response, accessToken);
  response.cookies.set('refresh_token', refreshToken, cookieOptions(REFRESH_MAX_AGE));
  return response;
}

/**
 * The signed-in, enabled user from the access_token cookie, or a 401.
 * Deliberately ignores Authorization headers: account routes are for
 * interactive sessions only.
 */
export async function requireCookieUser(request: NextRequest): Promise<AuthUser | NextResponse> {
  const token = request.cookies.get('access_token')?.value;
  if (!token) return fail('Not authenticated', 401, 'NOT_AUTHENTICATED');
  const payload = await verifyAccessToken(token);
  if (!payload?.userId) return fail('Invalid or expired token', 401, 'TOKEN_EXPIRED');
  const user = await findUserById(payload.userId);
  if (!user || user.disabled) return fail('Not authenticated', 401, 'NOT_AUTHENTICATED');
  return user;
}

/** Delete the user's sessions, except the one holding `keepRefreshToken`. */
export async function deleteSessions(userId: string, keepRefreshToken?: string): Promise<void> {
  if (keepRefreshToken) {
    await rqlite.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, hashToken(keepRefreshToken)]);
  } else {
    await rqlite.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}
