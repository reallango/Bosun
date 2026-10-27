/**
 * Random one-time codes and tokens, stored only as SHA-256 hashes and
 * compared in constant time. Pure helpers (no database).
 */
import crypto from 'crypto';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time equality of two hex digests (false on length mismatch). */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Uniformly random numeric code (default 6 digits). */
export function numericCode(digits = 6): string {
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
}

/** 32 random bytes, base64url: password reset tokens. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/i/l
export const BACKUP_CODE_COUNT = 10;

/** Normalise user input: lower case, drop spaces and dashes. */
export function normalizeBackupCode(code: string): string {
  return String(code).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `count` codes like "k7m2p-x9qrt" plus the hashes to store. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let j = 0; j < 10; j++) raw += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(c => sha256Hex(normalizeBackupCode(c))) };
}

export function parseBackupHashes(json: unknown): string[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Find `code` among the stored hashes (checking every entry, constant time
 * per entry). Returns the remaining hashes when it matched, else null.
 */
export function matchBackupCode(hashes: string[], code: string): string[] | null {
  const norm = normalizeBackupCode(code);
  if (norm.length !== 10) return null;
  const h = sha256Hex(norm);
  let index = -1;
  hashes.forEach((stored, i) => {
    if (safeEqualHex(stored, h) && index < 0) index = i;
  });
  if (index < 0) return null;
  return hashes.filter((_, i) => i !== index);
}

/** True when the input looks like a 6-digit TOTP / email code rather than a backup code. */
export function isNumericCode(code: string): boolean {
  return /^\d{6}$/.test(String(code).replace(/\s/g, ''));
}
