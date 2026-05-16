import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { hashPassword } from '@/lib/auth/password';
import { createAccessToken, generateRefreshToken, hashToken } from '@/lib/auth/jwt';

export async function POST(request: NextRequest) {
  try {
    // Check if setup is already complete
    const setupComplete = await getConfig('app.setup_complete');
    if (setupComplete === 'true') {
      return NextResponse.json(
        { error: { message: 'Setup already complete', code: 'SETUP_COMPLETE' } },
        { status: 400 }
      );
    }

    // Verify MASTER_KEY and AUTH_SECRET are set
    const masterKey = process.env.MASTER_KEY;
    const authSecret = process.env.AUTH_SECRET;
    
    if (!masterKey || masterKey.length < 32) {
      return NextResponse.json(
        { error: { message: 'MASTER_KEY environment variable must be set and at least 32 characters', code: 'MISSING_MASTER_KEY' } },
        { status: 400 }
      );
    }

    if (!authSecret || authSecret.length < 16) {
      return NextResponse.json(
        { error: { message: 'AUTH_SECRET environment variable must be set and at least 16 characters', code: 'MISSING_AUTH_SECRET' } },
        { status: 400 }
      );
    }

    const { username, password, email } = await request.json();

    if (!username || username.length < 3) {
      return NextResponse.json(
        { error: { message: 'Username must be at least 3 characters', code: 'INVALID_USERNAME' } },
        { status: 400 }
      );
    }

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: { message: 'Password must be at least 8 characters', code: 'WEAK_PASSWORD' } },
        { status: 400 }
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create admin user
    await rqlite.execute(
      `INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin')`,
      [username, email || null, passwordHash]
    );

    // Get the user ID
    const userResult = await rqlite.query(`SELECT id FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
    const userId = userResult.values[0]?.[0];

    // Mark setup as complete
    await setConfig('app.setup_complete', 'true');

    // Create tokens for auto-login
    const accessToken = await createAccessToken(userId as string, username, 'admin');
    const refreshToken = generateRefreshToken();
    const refreshHash = hashToken(refreshToken);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await rqlite.execute(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [userId, refreshHash, expiresAt]
    );

    const response = NextResponse.json({
      data: { user: { id: userId, username, role: 'admin' } }
    });

    response.cookies.set('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60,
      path: '/'
    });

    response.cookies.set('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60,
      path: '/'
    });

    return response;
  } catch (error) {
    console.error('Setup error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}