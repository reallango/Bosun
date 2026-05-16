import { NextRequest, NextResponse } from 'next/server';
import { createAccessToken, verifyAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get('refresh_token')?.value;
    if (!refreshToken) return NextResponse.json({ error: { message: 'No refresh token', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    const tokenHash = hashToken(refreshToken);
    const sess = await rqlite.query("SELECT s.user_id, s.expires_at, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?", [tokenHash]);
    if (!sess.values || sess.values.length === 0) return NextResponse.json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } }, { status: 401 });
    const [userId, expiresAt, username, role] = sess.values[0] as string[];
    if (new Date(expiresAt) < new Date()) return NextResponse.json({ error: { message: 'Token expired', code: 'TOKEN_EXPIRED' } }, { status: 401 });
    const newAccess = await createAccessToken(userId, username, role);
    const response = NextResponse.json({ data: { success: true } });
    response.cookies.set('access_token', newAccess, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 15 * 60 });
    return response;
  } catch (error) {
    console.error('Refresh error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}