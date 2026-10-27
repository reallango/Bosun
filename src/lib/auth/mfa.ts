/**
 * Second factor: TOTP (authenticator app), emailed codes and one-time backup
 * codes. Challenges live in mfa_challenges (hashed code, 5 attempts, 10-minute
 * expiry); the TOTP seed is stored encrypted in users.totp_secret and backup
 * codes as SHA-256 hashes in users.mfa_backup_codes.
 *
 * Challenge methods: 'totp' / 'email' (login step 2), 'email_setup' (confirm
 * email MFA on the account page), 'email_verify' (confirm disabling MFA).
 */
import crypto from 'crypto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { encrypt, decrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';
import { RateLimiter } from '@/lib/utils/rate-limiter';
import { sendMail, simpleEmail } from '@/lib/mail';
import { verifyTotp } from './totp';
import { sha256Hex, safeEqualHex, numericCode, isNumericCode, matchBackupCode, parseBackupHashes } from './codes';
import type { AuthUser } from './session';

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 5;

/** Per-IP limit on second-factor attempts (on top of per-challenge attempts). */
export const mfaLimiter = new RateLimiter({ maxAttempts: 20, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 });
/** Per-IP limit on emailed codes (login resend). */
export const emailCodeLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000, lockoutMs: 0 });
/** Per-user limit on password checks and code confirmations on the account page. */
export const accountLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 });

export interface Challenge {
  id: string;
  user_id: string;
  method: string;
  code_hash: string | null;
  attempts: number;
  expires_at: string;
  used_at: string | null;
}

export function encryptTotpSecret(secret: string): string {
  return encrypt(secret, getMasterKey());
}

export function decryptTotpSecret(enc: string): string {
  return decrypt(enc, getMasterKey());
}

/** Create a challenge (deleting long-expired ones). `code` is stored hashed. */
export async function createChallenge(userId: string, method: string, code?: string): Promise<Challenge> {
  const now = Date.now();
  await rqlite.execute('DELETE FROM mfa_challenges WHERE expires_at < ?', [new Date(now - 60 * 60 * 1000).toISOString()]);
  const c: Challenge = {
    id: crypto.randomUUID(),
    user_id: userId,
    method,
    code_hash: code ? sha256Hex(code) : null,
    attempts: 0,
    expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    used_at: null,
  };
  await rqlite.execute(
    'INSERT INTO mfa_challenges (id, user_id, method, code_hash, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)',
    [c.id, c.user_id, c.method, c.code_hash, c.expires_at]);
  return c;
}

export async function getChallenge(id: string): Promise<Challenge | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = rowsToObjects(await rqlite.query('SELECT id, user_id, method, code_hash, attempts, expires_at, used_at FROM mfa_challenges WHERE id = ?', [id]))[0];
  if (!row) return null;
  return { ...(row as unknown as Challenge), attempts: Number(row.attempts) || 0 };
}

export function challengeUsable(c: Challenge | null, nowMs = Date.now()): c is Challenge {
  return !!c && !c.used_at && Date.parse(c.expires_at) > nowMs && c.attempts < MAX_CHALLENGE_ATTEMPTS;
}

/** Count one attempt atomically; false when the challenge is used up, expired or out of attempts. */
export async function registerAttempt(c: Challenge): Promise<boolean> {
  const r = await rqlite.execute(
    'UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ? AND expires_at > ?',
    [c.id, MAX_CHALLENGE_ATTEMPTS, new Date().toISOString()]);
  return r.rows_affected === 1;
}

/** Mark used exactly once (false if someone else already did). */
export async function markChallengeUsed(c: Challenge, codeHash?: string): Promise<boolean> {
  const r = await rqlite.execute(
    'UPDATE mfa_challenges SET used_at = ?, code_hash = COALESCE(?, code_hash) WHERE id = ? AND used_at IS NULL',
    [new Date().toISOString(), codeHash ?? null, c.id]);
  return r.rows_affected === 1;
}

/** Replace the code of an email challenge (resend), keeping attempts. */
export async function replaceChallengeCode(c: Challenge, code: string): Promise<void> {
  await rqlite.execute('UPDATE mfa_challenges SET code_hash = ?, expires_at = ? WHERE id = ? AND used_at IS NULL',
    [sha256Hex(code), new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(), c.id]);
}

const PURPOSE_TEXT: Record<string, string> = {
  login: 'Use this code to finish signing in to Bosun.',
  setup: 'Use this code to turn on email sign-in codes for your Bosun account.',
  verify: 'Use this code to confirm a security change on your Bosun account.',
};

/** Email a 6-digit code to the user. Throws when sending fails. */
export async function sendCodeEmail(user: Pick<AuthUser, 'email' | 'username'>, code: string, purpose: 'login' | 'setup' | 'verify'): Promise<void> {
  if (!user.email) throw new Error('No email address on the account');
  const body = simpleEmail({
    title: 'Your Bosun security code',
    paragraphs: [`Hello ${user.username},`, PURPOSE_TEXT[purpose]],
    code,
    footer: 'The code expires in 10 minutes. If you did not request it, someone may know your password: change it.',
  });
  await sendMail({ to: user.email, subject: `[Bosun] Security code ${code}`, ...body });
}

/** Create an email challenge and send its code. */
export async function startEmailChallenge(user: AuthUser, method: string, purpose: 'login' | 'setup' | 'verify'): Promise<{ challenge: Challenge; sent: boolean }> {
  const code = numericCode();
  const challenge = await createChallenge(user.id, method, code);
  try {
    await sendCodeEmail(user, code, purpose);
    return { challenge, sent: true };
  } catch (err) {
    console.error('[auth] sending security code failed:', err instanceof Error ? err.message : err);
    return { challenge, sent: false };
  }
}

export type FactorResult =
  | { ok: true; via: 'totp' | 'email' | 'backup'; totpStep?: number }
  | { ok: false };

/**
 * Verify a code for `user`: a 6-digit code is checked against the user's
 * method (TOTP seed, or the email challenge's hash); anything else as a
 * backup code, which is consumed on success. With `preventReplay`, a TOTP
 * step already used for a sign-in is refused.
 */
export async function verifySecondFactor(
  user: AuthUser,
  code: string,
  options: { challenge?: Challenge | null; method?: 'totp' | 'email'; preventReplay?: boolean; allowBackup?: boolean } = {},
): Promise<FactorResult> {
  const method = options.method ?? user.mfa_method;
  const clean = String(code || '').trim();
  if (!clean || clean.length > 32) return { ok: false };

  if (isNumericCode(clean)) {
    const digits = clean.replace(/\s/g, '');
    if (method === 'totp') {
      if (!user.totp_secret) return { ok: false };
      let secret: string;
      try { secret = decryptTotpSecret(user.totp_secret); } catch { return { ok: false }; }
      const step = verifyTotp(secret, digits);
      if (step === null) return { ok: false };
      if (options.preventReplay) {
        const used = await rqlite.query(
          'SELECT 1 FROM mfa_challenges WHERE user_id = ? AND code_hash = ? AND used_at IS NOT NULL LIMIT 1', [user.id, `totp:${step}`]);
        if (used.values?.length) return { ok: false };
      }
      return { ok: true, via: 'totp', totpStep: step };
    }
    if (method === 'email') {
      const c = options.challenge;
      if (!c?.code_hash || Date.parse(c.expires_at) <= Date.now()) return { ok: false };
      return safeEqualHex(c.code_hash, sha256Hex(digits)) ? { ok: true, via: 'email' } : { ok: false };
    }
    return { ok: false };
  }

  if (options.allowBackup === false) return { ok: false };
  const stored = user.mfa_backup_codes;
  const remaining = matchBackupCode(parseBackupHashes(stored), clean);
  if (!remaining) return { ok: false };
  // Conditional update: a code can only be consumed once even under concurrency.
  const r = await rqlite.execute('UPDATE users SET mfa_backup_codes = ? WHERE id = ? AND mfa_backup_codes = ?',
    [JSON.stringify(remaining), user.id, stored]);
  return r.rows_affected === 1 ? { ok: true, via: 'backup' } : { ok: false };
}
