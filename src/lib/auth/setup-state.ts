import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';
import { readClusterFile, writeClusterFile } from '@/lib/cluster/config';

const JOIN_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Is a join started from the setup page still unfinished? True from the moment
 * the join is submitted until this node can see the cluster's data (more than
 * one voter and at least one user). The marker is cleared here once it has.
 * While it is true the database may be unreadable, so setup and login must not
 * treat that as "an existing installation": the setup page is where a failed
 * join is retried or cancelled.
 */
export async function joinStalled(): Promise<boolean> {
  const started = readClusterFile().join_started_at;
  if (!started) return false;
  // The marker lets an unauthenticated page wipe or re-join this node, so it never lasts forever: the poller clears
  // it once the join has worked, and after a day it no longer counts (a join that is still stuck by then needs
  // Settings > Cluster or the README's recovery steps).
  const age = Date.now() - Date.parse(String(started));
  if (!Number.isFinite(age) || age > JOIN_MARKER_TTL_MS) return false;
  try {
    if (await rqlite.isReady()) {
      const users = Number((await rqlite.query('SELECT COUNT(*) FROM users')).values?.[0]?.[0] || 0);
      const voters = (await rqlite.getNodes()).filter(n => n.voter).length;
      if (voters > 1 && users > 0) {
        writeClusterFile({ join_started_at: null });
        return false;
      }
    }
  } catch { /* restarting */ }
  return true;
}

/**
 * Does this node still need its initial setup? True when setup is explicitly
 * incomplete and no accounts exist, or when a join from the setup page has not
 * finished. If the database cannot be read (not ready, no quorum) otherwise,
 * the answer is false, so callers fall back to login and never send an
 * existing installation to /setup.
 */
export async function isSetupRequired(): Promise<boolean> {
  if (await joinStalled()) return true;
  if ((await getConfig('app.setup_complete')) !== 'false') return false;
  try {
    const users = await rqlite.query('SELECT COUNT(*) FROM users');
    return Number(users.values?.[0]?.[0] || 0) === 0;
  } catch {
    return false;
  }
}
