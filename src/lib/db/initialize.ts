import { rqlite } from './rqlite-client';
import { runMigrations, getCurrentVersion, SCHEMA_VERSION } from './migrations';

// Kept on globalThis: instrumentation and route handlers are separate bundles
// with separate module state, but must share one initialisation.
const g = globalThis as unknown as { __bosunDbInit?: Promise<void> | null };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Bring the database to the current schema.
 *
 * Waits for this node's rqlite, then for a cluster leader (up to ~45 s, which
 * covers a normal cluster start/election). With a leader, migrations run
 * (they are forwarded to the leader; nodes racing each other are handled in
 * runMigrations). Without one - this node is cut off from the majority - the
 * app still starts read-only if the local copy already has the current
 * schema, so dashboards keep showing the last replicated data.
 */
export async function initializeDatabase(): Promise<void> {
  for (let attempt = 0; attempt < 60 && !(await rqlite.isUp()); attempt++) {
    if (attempt % 10 === 0) console.log('[db] waiting for rqlite...');
    await sleep(1000);
  }
  if (!(await rqlite.isUp())) throw new Error('rqlite did not start');

  for (let attempt = 0; attempt < 45 && !(await rqlite.isReady()); attempt++) {
    if (attempt % 10 === 0) console.log('[db] waiting for a cluster leader...');
    await sleep(1000);
  }

  if (await rqlite.isReady()) {
    await runMigrations();
    const { seedBundledPackages } = await import('@/lib/widgets/bundled-seed');
    await seedBundledPackages();
    return;
  }

  const version = await getCurrentVersion().catch(() => 0);
  if (version >= SCHEMA_VERSION) {
    console.warn(`[db] no cluster leader; starting read-only on the local copy (schema ${version})`);
    return;
  }
  throw new Error('No database cluster leader and the local copy has no current schema yet');
}

/**
 * Initialise once per process. Concurrent callers share the same promise; a
 * failure clears it so the next caller retries.
 */
export function ensureDatabase(): Promise<void> {
  if (!g.__bosunDbInit) {
    g.__bosunDbInit = initializeDatabase().catch(err => {
      g.__bosunDbInit = null;
      throw err;
    });
  }
  return g.__bosunDbInit as Promise<void>;
}

export default initializeDatabase;
