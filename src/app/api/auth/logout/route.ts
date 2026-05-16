import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    const refreshToken = request.cookies.get('refresh_token')?.value;
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';

    if (refreshToken) { const h = hashToken(refreshToken); await rqlite.execute("DELETE FROM sessions WHERE token_hash = ?", [h]); }
    if (accessToken) { const p = await verifyAccessToken(accessToken); if (p) await logAudit({ userId: p.userId, action: AuditActions.LOGOUT, status: 'success', ipAddress: ip }); }
    const response = NextResponse.json({ data: { success: true } });
    response.cookies.set('access_token', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
    response.cookies.set('refresh_token', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}