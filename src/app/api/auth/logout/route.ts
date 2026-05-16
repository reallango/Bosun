import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { hashToken } from '@/lib/auth/jwt';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    const refreshToken = request.cookies.get('refresh_token')?.value;
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';

    let userId: string | null = null;
    
    if (accessToken) {
      const payload = await verifyAccessToken(accessToken);
      userId = payload?.userId || null;
    }

    // Delete session
    if (refreshToken) {
      const refreshHash = hashToken(refreshToken);
      await rqlite.execute(`DELETE FROM sessions WHERE token_hash = ?`, [refreshHash]);
    }

    // Log audit
    if (userId) {
      await logAudit({ userId, action: AuditActions.LOGOUT, status: 'success', ipAddress: ip });
    }

    const response = NextResponse.json({ data: { success: true } });
    response.cookies.set('access_token', '', { maxAge: 0, path: '/' });
    response.cookies.set('refresh_token', '', { maxAge: 0, path: '/' });

    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}