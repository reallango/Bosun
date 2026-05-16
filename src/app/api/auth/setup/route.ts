import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { hashPassword } from '@/lib/auth/password';
import { createAccessToken, generateRefreshToken, hashToken } from '@/lib/auth/jwt';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const setupComplete = await getConfig('app.setup_complete');
    if (setupComplete === 'true') {
      return NextResponse.json({ error: { message: 'Setup already complete', code: 'SETUP_COMPLETE' } }, { status: 400 });
    }
    const masterKey = process.env.MASTER_KEY;
    const authSecret = process.env.AUTH_SECRET;
    if (!masterKey || masterKey.length < 32) {
      return NextResponse.json({ error: { message: 'MASTER_KEY must be set and 32+ characters', code: 'MISSING_MASTER_KEY' } }, { status: 400 });
    }
    if (!authSecret || authSecret.length < 16) {
      return NextResponse.json({ error: { message: 'AUTH_SECRET must be set and 16+ characters', code: 'MISSING_AUTH_SECRET' } }, { status: 400 });
    }
    const { username, password, email } = await request.json();
    if (!username || !password || password.length < 8) return NextResponse.json({ error: { message: 'Username and password (8+ chars) required' } }, { status: 400 });
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await rqlite.execute("INSERT INTO users (id, username, password_hash, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)", [userId, username, passwordHash, email || null, now, now]);
    await setConfig('app.setup_complete', 'true');
    const accessToken = await createAccessToken(userId, username, 'admin');
    const refreshToken = generateRefreshToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    await rqlite.execute("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)", [sessionId, userId, hashToken(refreshToken), expiresAt]);
    const response = NextResponse.json({ data: { user: { id: userId, username, role: 'admin' } } });
    response.cookies.set('access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 15*60 });
    response.cookies.set('refresh_token', refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 7*24*60*60 });
    return response;
  } catch (error) {
    console.error('Setup error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}