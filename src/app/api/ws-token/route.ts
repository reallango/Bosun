
import { NextRequest, NextResponse } from 'next/server';
import { authSecret } from '@/lib/auth/jwt';
import { requireUserLevel } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { SignJWT } from 'jose';

/**
 * Short-lived token for the terminal WebSocket (host and container shells).
 * Full access only, and only for a signed-in user: API keys are refused.
 */
export async function POST(request: NextRequest) {
  try {
    const payload = await requireUserLevel(request, 'admin');
    if (payload instanceof NextResponse) return payload;

    // Get user info from database
    const r = await rqlite.query(
      'SELECT id, username, role, disabled FROM users WHERE id = ?',
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
    const role = row[2] as string;
    if (Number(row[3]) === 1 || role !== 'admin') {
      return NextResponse.json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } }, { status: 403 });
    }

    // Create a short-lived WebSocket token (5 minutes)
    const secret = authSecret();
    // ws-server verifies the signature, expiry, type and role of this token.
    const wsToken = await new SignJWT({ userId, username, role, type: 'ws', authType: 'session' })
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
