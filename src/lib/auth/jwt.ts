import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import crypto from 'crypto';

const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-secret-change-me';

export interface TokenPayload extends JWTPayload {
  userId: string;
  username: string;
  role: string;
}

export async function createAccessToken(userId: string, username: string, role: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA256' },
    false,
    ['sign']
  );

  return new SignJWT({ userId, username, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<TokenPayload | null> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(AUTH_SECRET),
      { name: 'HMAC', hash: 'SHA256' },
      false,
      ['verify']
    );

    const { payload } = await jwtVerify(token, key);
    return payload as TokenPayload;
  } catch {
    return null;
  }
}

export function generateRefreshToken(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}