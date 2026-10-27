/**
 * Authenticate `Authorization: Bearer bosun_...` API keys.
 *
 * Rows are cached per prefix for a short time (revocation on another cluster
 * node takes effect within KEY_CACHE_MS; here immediately). last_used_at /
 * last_used_ip are written at most once a minute per key. Each key is rate
 * limited to API_KEY_RATE_LIMIT requests per minute.
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { RateLimiter } from '@/lib/utils/rate-limiter';
import { apiKeyState, parseApiKey, verifyApiKey } from './api-keys';
import { isRole } from './levels';
import type { TokenPayload } from './jwt';

const KEY_CACHE_MS = 30_000;
const LAST_USED_WRITE_MS = 60_000;
export const API_KEY_RATE_LIMIT = { maxAttempts: 300, windowMs: 60_000, lockoutMs: 0 };

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  role: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface State {
  rows: Map<string, { row: ApiKeyRow | null; at: number }>;
  lastUsedWrite: Map<string, number>;
  limiter: RateLimiter;
}

const g = globalThis as unknown as { __bosunApiKeys?: State };
const state: State = g.__bosunApiKeys ?? (g.__bosunApiKeys = {
  rows: new Map(),
  lastUsedWrite: new Map(),
  limiter: new RateLimiter(API_KEY_RATE_LIMIT),
});

export type ApiKeyAuthResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; status: number; code: string; message: string; retryAfterMs?: number };

async function findByPrefix(prefix: string): Promise<ApiKeyRow | null> {
  const cached = state.rows.get(prefix);
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.row;
  const r = await rqlite.query(
    'SELECT id, name, key_hash, role, expires_at, revoked_at FROM api_keys WHERE key_prefix = ?', [prefix]);
  const row = (rowsToObjects(r)[0] as unknown as ApiKeyRow | undefined) ?? null;
  if (state.rows.size > 1000) state.rows.clear();
  state.rows.set(prefix, { row, at: Date.now() });
  return row;
}

/** Forget cached key rows (after revoking/deleting a key in this process). */
export function invalidateApiKeyCache(): void {
  state.rows.clear();
}

export async function authenticateApiKey(key: string, ip: string | null): Promise<ApiKeyAuthResult> {
  const parsed = parseApiKey(key);
  if (!parsed) return { ok: false, status: 401, code: 'INVALID_API_KEY', message: 'Invalid API key' };

  let row: ApiKeyRow | null;
  try {
    row = await findByPrefix(parsed.prefix);
  } catch (err) {
    console.error('API key lookup failed:', err);
    return { ok: false, status: 503, code: 'AUTH_UNAVAILABLE', message: 'Could not verify the API key right now' };
  }
  if (!row || !verifyApiKey(key, row.key_hash)) {
    return { ok: false, status: 401, code: 'INVALID_API_KEY', message: 'Invalid API key' };
  }
  const keyState = apiKeyState(row);
  if (keyState === 'revoked') return { ok: false, status: 401, code: 'API_KEY_REVOKED', message: 'API key has been revoked' };
  if (keyState === 'expired') return { ok: false, status: 401, code: 'API_KEY_EXPIRED', message: 'API key has expired' };
  if (!isRole(row.role)) return { ok: false, status: 401, code: 'INVALID_API_KEY', message: 'Invalid API key' };

  const limited = state.limiter.consume(row.id);
  if (!limited.allowed) {
    return { ok: false, status: 429, code: 'RATE_LIMITED', message: 'Too many requests for this API key', retryAfterMs: limited.retryAfterMs };
  }

  const now = Date.now();
  if (now - (state.lastUsedWrite.get(row.id) ?? 0) >= LAST_USED_WRITE_MS) {
    state.lastUsedWrite.set(row.id, now);
    // Fire and forget: usage tracking must not slow down or fail the request.
    rqlite.execute('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?',
      [new Date(now).toISOString(), ip ? ip.slice(0, 64) : null, row.id])
      .catch(err => console.error('API key last_used update failed:', err));
  }

  return {
    ok: true,
    payload: {
      userId: `apikey:${row.id}`,
      username: row.name,
      role: row.role,
      authType: 'api_key',
      apiKeyId: row.id,
    },
  };
}
