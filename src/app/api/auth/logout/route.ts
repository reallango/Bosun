import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { clientIp, cookieOptions } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    const refreshToken = request.cookies.get('refresh_token')?.value;
    const ip = clientIp(request);

    if (refreshToken) { const h = hashToken(refreshToken); await rqlite.execute("DELETE FROM sessions WHERE token_hash = ?", [h]); }
    if (accessToken) { const p = await verifyAccessToken(accessToken); if (p) await logAudit({ userId: p.userId, action: AuditActions.LOGOUT, status: 'success', ipAddress: ip }); }
    const response = NextResponse.json({ data: { success: true } });
    // Same attributes the cookies were set with (COOKIE_SECURE), or the browser keeps them.
    response.cookies.set('access_token', '', cookieOptions(0));
    response.cookies.set('refresh_token', '', cookieOptions(0));
    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return internalError(error);
  }
}
