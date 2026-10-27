/**
 * Cached view of every user's current role and disabled flag, so requireAuth
 * can cut off disabled/deleted users and apply role changes within ~30 s
 * without a database query per request. One small query (all users) per
 * TTL per process; changes made through this process invalidate it at once.
 */
import { rqlite } from '@/lib/db/rqlite-client';

export interface UserStatus {
  role: string;
  disabled: boolean;
}

const TTL_MS = 30_000;
/** A token for a user missing from the cache triggers a reload, at most this often. */
const MISS_RELOAD_MS = 5_000;

interface Cache {
  users: Map<string, UserStatus> | null;
  loadedAt: number;
  loading: Promise<void> | null;
}

const g = globalThis as unknown as { __bosunUserStatus?: Cache };
const cache: Cache = g.__bosunUserStatus ?? (g.__bosunUserStatus = { users: null, loadedAt: 0, loading: null });

async function load(): Promise<void> {
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    try {
      const r = await rqlite.query('SELECT id, role, disabled FROM users');
      const users = new Map<string, UserStatus>();
      for (const [id, role, disabled] of r.values || []) {
        users.set(String(id), { role: String(role), disabled: Number(disabled) === 1 });
      }
      cache.users = users;
      cache.loadedAt = Date.now();
    } catch (err) {
      // Keep serving the previous snapshot (or none: callers then trust the token).
      console.error('User status refresh failed:', err);
      cache.loadedAt = Date.now() - TTL_MS + MISS_RELOAD_MS;
    } finally {
      cache.loading = null;
    }
  })();
  return cache.loading;
}

/**
 * Current status of a user: the cached row, `null` when the user does not
 * exist (deleted), or `undefined` when the database could not be read.
 */
export async function getUserStatus(userId: string): Promise<UserStatus | null | undefined> {
  const now = Date.now();
  if (!cache.users || now - cache.loadedAt > TTL_MS) await load();
  let status = cache.users?.get(userId);
  if (!status && cache.users) {
    // Possibly a user created moments ago on another node: reload, but not
    // more often than MISS_RELOAD_MS; until then trust the token.
    if (Date.now() - cache.loadedAt <= MISS_RELOAD_MS) return undefined;
    await load();
    status = cache.users?.get(userId);
  }
  if (!cache.users) return undefined;
  return status ?? null;
}

/** Drop the cache (after creating, changing or deleting a user here). */
export function invalidateUserStatus(): void {
  cache.users = null;
  cache.loadedAt = 0;
}
