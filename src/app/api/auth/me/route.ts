import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
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
        { error: { message: 'Invalid token', code: 'INVALID_TOKEN' } },
        { status: 401 }
      );
    }

    const result = await rqlite.query(
      `SELECT id, username, display_name, email, role, preferences, last_login 
       FROM users WHERE id = '${payload.userId}'`
    );

    if (result.values.length === 0) {
      return NextResponse.json(
        { error: { message: 'User not found', code: 'USER_NOT_FOUND' } },
        { status: 401 }
      );
    }

    const [id, username, displayName, email, role, preferences, lastLogin] = result.values[0];
    
    return NextResponse.json({
      data: {
        user: {
          id,
          username,
          display_name: displayName,
          email,
          role,
          preferences: preferences ? JSON.parse(preferences as string) : {},
          last_login: lastLogin
        }
      }
    });
  } catch (error) {
    console.error('Me error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}