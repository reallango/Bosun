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
        // Widget updates in the notification bell (the leader checks; see lib/widgets/update-check.ts).
        const { startWidgetUpdateCheck } = await import('@/lib/widgets/update-check');
        startWidgetUpdateCheck();
        // Self-update: where this node runs, closing a finished rolling update, and new Bosun images (lib/update/rollout.ts).
        const { startUpdateTasks } = await import('@/lib/update/rollout');
        startUpdateTasks();
      })
      .catch(err => console.error('[db] initialisation failed:', err));
  }
}
