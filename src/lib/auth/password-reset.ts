/**
 * Password reset tokens: 32 random bytes (base64url) emailed as a link; only
 * the SHA-256 is stored in password_resets, valid for 30 minutes, once.
 */
import crypto from 'crypto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { RateLimiter } from '@/lib/utils/rate-limiter';
import { randomToken, sha256Hex } from './codes';

export const RESET_TTL_MS = 30 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

/** Reset requests per IP. */
export const forgotLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 0 });
/** Reset submissions per IP (token guessing). */
export const resetLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 });

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

/** Create a token for the user; returns the raw token (to email, never log). */
export async function createResetToken(userId: string, ip: string): Promise<string> {
  const now = Date.now();
  const token = randomToken(32);
  await rqlite.executeBatch([
    // Drop stale rows and any earlier unused token for this user.
    { sql: 'DELETE FROM password_resets WHERE expires_at < ? OR (user_id = ? AND used_at IS NULL)', params: [new Date(now - 24 * 60 * 60 * 1000).toISOString(), userId] },
    {
      sql: 'INSERT INTO password_resets (id, user_id, token_hash, expires_at, ip_address) VALUES (?, ?, ?, ?, ?)',
      params: [crypto.randomUUID(), userId, sha256Hex(token), new Date(now + RESET_TTL_MS).toISOString(), ip],
    },
  ], { transaction: true });
  return token;
}

export interface ResetRow { id: string; user_id: string; expires_at: string; used_at: string | null }

/** Look up an unused, unexpired token (lookup by hash, so no timing oracle on the token itself). */
export async function findValidReset(token: unknown): Promise<ResetRow | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = rowsToObjects(await rqlite.query(
    'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?', [sha256Hex(token)]))[0] as unknown as ResetRow | undefined;
  if (!row || row.used_at || !(Date.parse(row.expires_at) > Date.now())) return null;
  return row;
}

/** Mark used exactly once. */
export async function consumeReset(row: ResetRow): Promise<boolean> {
  const r = await rqlite.execute('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', [new Date().toISOString(), row.id]);
  return r.rows_affected === 1;
}
