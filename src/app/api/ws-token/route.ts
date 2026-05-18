import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, createAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { SignJWT } from 'jose';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json(
        { error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } },
        { status: 401 }
      );
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload) {
      return NextResponse.json(
        { error: { message: 'Invalid token', code: 'TOKEN_EXPIRED' } },
        { status: 401 }
      );
    }

    // Get user info from database
    const r = await rqlite.query(
      'SELECT id, username, role FROM users WHERE id = ?',
      [payload.userId]
    );
    if (!r.values || r.values.length === 0) {
      return NextResponse.json(
        { error: { message: 'User not found' } },
        { status: 404 }
      );
    }
    const row = r.values[0];
    const userId = row[0] as string;
    const username = row[1] as string;

    // Create a short-lived WebSocket token (5 minutes)
    const authSecret = process.env.AUTH_SECRET || 'fallback-secret-change-me';
    const secret = new TextEncoder().encode(authSecret);
    const wsToken = await new SignJWT({ userId, username, type: 'ws' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    return NextResponse.json({ data: { token: wsToken } });
  } catch (error) {
    console.error('ws-token error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}