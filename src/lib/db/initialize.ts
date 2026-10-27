import { rqlite } from './rqlite-client';
import { runMigrations } from './migrations';

// Kept on globalThis: instrumentation and route handlers are separate bundles
// with separate module state, but must share one initialisation.
const g = globalThis as unknown as { __bosunDbInit?: Promise<void> | null };

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
  if (!g.__bosunDbInit) {
    g.__bosunDbInit = initializeDatabase().catch(err => {
      g.__bosunDbInit = null;
      throw err;
    });
  }
  return g.__bosunDbInit as Promise<void>;
}

export default initializeDatabase;
