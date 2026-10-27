import { SignJWT, jwtVerify, JWTPayload } from 'jose';
import crypto from 'crypto';
import { getAuthSecret } from '@/lib/secrets';

const DEV_FALLBACK_SECRET = 'fallback-secret-change-me';

/**
 * JWT signing key. Production refuses to sign or verify with the well-known
 * development fallback (anyone could forge tokens with it).
 */
export function authSecret(): Uint8Array {
  const value = getAuthSecret();
  if (!value) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET is not set and no secrets file could be created');
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(value);
}

export interface TokenPayload extends JWTPayload {
  userId: string;
  username: string;
  role: string;
}

export async function createAccessToken(userId: string, username: string, role: string): Promise<string> {
  return new SignJWT({ userId, username, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(authSecret());
}

export async function verifyAccessToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret());
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