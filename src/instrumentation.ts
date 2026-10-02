/**
 * Next.js instrumentation hook (enabled via experimental.instrumentationHook).
 *
 * Starts the server health checker once per Node.js server process so that
 * `servers.is_online` / `last_seen` are maintained. Nothing else calls
 * `startHealthChecker`, so without this the checker never runs and every server
 * shows as Offline.
 */
export async function register() {
  // The instrumentation file is compiled for the edge runtime too, where Node
  // builtins (crypto) are unavailable. Keeping the import inside the
  // `NEXT_RUNTIME === 'nodejs'` branch lets webpack drop it from the edge bundle
  // (NEXT_RUNTIME is replaced with the literal runtime name at build time).
  // Skip the production build, where the checker's interval would keep the
  // build process alive.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startHealthChecker } = await import('@/lib/health/checker');
    await startHealthChecker();
  }
}
