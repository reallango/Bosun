import { NextRequest, NextResponse } from 'next/server';
import { createAccessToken, verifyAccessToken, hashToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get('refresh_token')?.value;
    
    if (!refreshToken) {
      return NextResponse.json(
        { error: { message: 'No refresh token', code: 'NO_TOKEN' } },
        { status: 401 }
      );
    }

    const refreshHash = hashToken(refreshToken);
    const now = new Date().toISOString();
    
    // Find session
    const result = await rqlite.query(
      `SELECT s.user_id, s.expires_at, u.username, u.role 
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.token_hash = '${refreshHash}' AND s.expires_at > '${now}'`
    );

    if (result.values.length === 0) {
      return NextResponse.json(
        { error: { message: 'Invalid or expired session', code: 'INVALID_SESSION' } },
        { status: 401 }
      );
    }

    const [userId, expiresAt, username, role] = result.values[0];

    // Generate new access token
    const accessToken = await createAccessToken(userId as string, username as string, role as string);

    const response = NextResponse.json({ data: { success: true } });
    
    response.cookies.set('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60,
      path: '/'
    });

    return response;
  } catch (error) {
    console.error('Refresh error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}