import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { createAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { setAccessCookie } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get('refresh_token')?.value;
    if (!refreshToken) return NextResponse.json({ error: { message: 'No refresh token', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    const tokenHash = hashToken(refreshToken);
    const sess = await rqlite.query("SELECT s.user_id, s.expires_at, u.username, u.role, u.disabled FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ?", [tokenHash]);
    if (!sess.values || sess.values.length === 0) return NextResponse.json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } }, { status: 401 });
    const [userId, expiresAt, username, role, disabled] = sess.values[0] as [string, string, string, string, unknown];
    if (new Date(expiresAt) < new Date()) return NextResponse.json({ error: { message: 'Token expired', code: 'TOKEN_EXPIRED' } }, { status: 401 });
    if (Number(disabled) === 1) {
      // A disabled account loses its sessions.
      await rqlite.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }
    const newAccess = await createAccessToken(userId, username, role);
    const response = NextResponse.json({ data: { success: true } });
    setAccessCookie(response, newAccess);
    return response;
  } catch (error) {
    console.error('Refresh error:', error);
    return internalError(error);
  }
}
