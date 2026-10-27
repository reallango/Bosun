/**
 * API key format and verification (pure; no database access).
 *
 * A key looks like `bosun_<prefix>_<secret>`:
 *   - prefix: 8 lowercase hex chars, stored in api_keys.key_prefix (unique),
 *     used to find the row;
 *   - secret: 32 random bytes, base64url (43 chars; may contain `_` and `-`).
 * Only the SHA-256 of the full key is stored (api_keys.key_hash).
 */
import crypto from 'crypto';

export const API_KEY_SCHEME = 'bosun';
const PREFIX_BYTES = 4; // 8 hex chars
const SECRET_BYTES = 32;
const KEY_RE = /^bosun_([0-9a-f]{8})_([A-Za-z0-9_-]{43,128})$/;

export interface GeneratedApiKey {
  /** The full key; shown to the user once and never stored. */
  key: string;
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const key = `${API_KEY_SCHEME}_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** Does this string look like a Bosun API key? Returns its prefix, or null. */
export function parseApiKey(value: string | null | undefined): { prefix: string } | null {
  if (!value) return null;
  const m = KEY_RE.exec(value.trim());
  return m ? { prefix: m[1] } : null;
}

/** Constant-time comparison of a presented key against the stored hash. */
export function verifyApiKey(key: string, storedHash: string): boolean {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashApiKey(key), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** SQLite DATETIME strings ("YYYY-MM-DD HH:MM:SS", UTC) or ISO strings to ms. */
export function parseDbTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export type ApiKeyState = 'active' | 'revoked' | 'expired';

export function apiKeyState(row: { revoked_at?: unknown; expires_at?: unknown }, now = Date.now()): ApiKeyState {
  if (row.revoked_at) return 'revoked';
  const exp = parseDbTime(row.expires_at);
  if (exp !== null && exp <= now) return 'expired';
  return 'active';
}

export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

/** Expiry timestamp (ISO) for "N days from now"; null = never. */
export function expiryFromDays(days: unknown, now = Date.now()): string | null | undefined {
  if (days === null || days === undefined || days === '' || days === 'never' || days === 0) return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return undefined; // invalid
  return new Date(now + n * 86_400_000).toISOString();
}
