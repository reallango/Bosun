import { rqlite } from './rqlite-client';
import { runMigrations } from './migrations';

let initPromise: Promise<void> | null = null;

export async function initializeDatabase(): Promise<void> {
  // Wait up to ~60 s for rqlite to be ready (it starts alongside the app).
  for (let attempt = 0; attempt < 60 && !(await rqlite.isReady()); attempt++) {
    if (attempt % 10 === 0) console.log('[db] waiting for rqlite...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!(await rqlite.isReady())) throw new Error('rqlite did not become ready');
  await runMigrations();
}

/**
 * Initialise once per process. Concurrent callers share the same promise; a
 * failure clears it so the next caller retries.
 */
export function ensureDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = initializeDatabase().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export default initializeDatabase;
