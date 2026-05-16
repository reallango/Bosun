import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createAccessToken, generateRefreshToken, hashToken } from '@/lib/auth/jwt';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { checkLoginRateLimit, recordLoginAttempt } from '@/lib/utils/rate-limiter';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';

    // Check rate limit
    const rateCheck = checkLoginRateLimit(ip);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: { message: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED', lockedUntil: rateCheck.lockedUntil } },
        { status: 429 }
      );
    }

    // Get user
    const result = await rqlite.query(`SELECT id, username, password_hash, role FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
    
    if (result.values.length === 0) {
      recordLoginAttempt(ip);
      await logAudit({ action: AuditActions.LOGIN_FAILED, details: `User not found: ${username}`, status: 'failure', ipAddress: ip });
      return NextResponse.json(
        { error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } },
        { status: 401 }
      );
    }

    const [id, dbUsername, passwordHash, role] = result.values[0];
    const valid = await verifyPassword(password, passwordHash as string);

    if (!valid) {
      recordLoginAttempt(ip);
      await logAudit({ userId: id as string, action: AuditActions.LOGIN_FAILED, details: `Wrong password for ${username}`, status: 'failure', ipAddress: ip });
      return NextResponse.json(
        { error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } },
        { status: 401 }
      );
    }

    // Create tokens
    const accessToken = await createAccessToken(id as string, dbUsername as string, role as string);
    const refreshToken = generateRefreshToken();
    const refreshHash = hashToken(refreshToken);

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await rqlite.execute(
      `INSERT INTO sessions (user_id, token_hash, ip_address, expires_at) VALUES (?, ?, ?, ?)`,
      [id, refreshHash, ip, expiresAt]
    );

    // Update last login
    await rqlite.execute(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [id]);

    // Log audit
    await logAudit({ userId: id as string, action: AuditActions.LOGIN, status: 'success', ipAddress: ip });

    // Create response with cookies
    const response = NextResponse.json({
      data: {
        user: { id, username: dbUsername, role }
      }
    });

    // Set cookies
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
    console.error('Login error:', error);
    return NextResponse.json(
      { error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }
}