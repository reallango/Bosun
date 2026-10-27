import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';

/**
 * Does this node still need its initial setup? True only when setup is
 * explicitly incomplete and no accounts exist. If the database cannot be read
 * (not ready, no quorum) the answer is false, so callers fall back to login
 * and never send an existing installation to /setup.
 */
export async function isSetupRequired(): Promise<boolean> {
  if ((await getConfig('app.setup_complete')) !== 'false') return false;
  try {
    const users = await rqlite.query('SELECT COUNT(*) FROM users');
    return Number(users.values?.[0]?.[0] || 0) === 0;
  } catch {
    return false;
  }
}
