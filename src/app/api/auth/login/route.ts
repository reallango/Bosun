import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createAccessToken, generateRefreshToken, hashToken } from '@/lib/auth/jwt';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { checkLoginRateLimit, recordLoginAttempt } from '@/lib/utils/rate-limiter';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';

    const rateLimit = checkLoginRateLimit(ip);
    if (!rateLimit.allowed) return NextResponse.json({ error: { message: 'Too many attempts', code: 'RATE_LIMITED' } }, { status: 429 });

    const userResult = await rqlite.query("SELECT id, username, password_hash, role FROM users WHERE username = ?", [username]);
    if (!userResult.values || userResult.values.length === 0) {
      recordLoginAttempt(ip);
      await logAudit({ action: AuditActions.LOGIN_FAILED, details: `Unknown user: ${username}`, status: 'failure', ipAddress: ip });
      return NextResponse.json({ error: { message: 'Invalid username or password', code: 'INVALID_CREDENTIALS' } }, { status: 401 });
    }
    const [userId, uname, pwHash, role] = userResult.values[0] as [string, string, string, string];
    const valid = await verifyPassword(password, pwHash);
    if (!valid) {
      recordLoginAttempt(ip);
      await logAudit({ userId, action: AuditActions.LOGIN_FAILED, status: 'failure', ipAddress: ip });
      return NextResponse.json({ error: { message: 'Invalid username or password', code: 'INVALID_CREDENTIALS' } }, { status: 401 });
    }
    const accessToken = await createAccessToken(userId, uname, role);
    const refreshToken = generateRefreshToken();
    const refreshHash = hashToken(refreshToken);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await rqlite.execute("INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)", [sessionId, userId, refreshHash, ip, expiresAt]);
    await rqlite.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
    await logAudit({ userId, action: AuditActions.LOGIN, status: 'success', ipAddress: ip });
    const response = NextResponse.json({ data: { user: { id: userId, username: uname, role } } });
    response.cookies.set('access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 15 * 60 });
    response.cookies.set('refresh_token', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 7 * 24 * 60 * 60 });
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}