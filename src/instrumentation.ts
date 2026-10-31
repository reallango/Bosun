/**
 * Next.js instrumentation hook (enabled via experimental.instrumentationHook).
 *
 * Creates/upgrades the database schema once per Node.js server process at
 * startup (retrying while rqlite comes up), so the poller and the UI never see
 * a half-initialised database. Host liveness and data collection are owned by
 * the poller process; the web server opens SSH only for user actions.
 */
export async function register() {
  // NEXT_RUNTIME is replaced at build time, so the edge bundle drops this
  // branch. Skip the production build phase.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { ensureDatabase } = await import('@/lib/db/initialize');
    void ensureDatabase()
      .then(async () => {
        // Every node keeps the packages' files on its own disk, written from the database (see lib/widgets/materialize.ts).
        const { startPackageFileSync } = await import('@/lib/widgets/materialize-db');
        startPackageFileSync();
      })
      .catch(err => console.error('[db] initialisation failed:', err));
  }
}
