/**
 * Install the bundled widget packages that are missing and upgrade the ones the image ships a newer version of.
 * Runs once after the migrations. A package installed from GitHub comes from this same repository, so a newer
 * bundled version replaces it and its secrets are kept; a zip upload is the admin's and is left alone. Removed
 * ones are not brought back. Never throws.
 */
import { compareVersions, manifestToJson, type PackageManifest } from '@/lib/widgets/package-manifest';
import { getInstalledPackage, installPackage } from '@/lib/widgets/package-store';
import { rqlite } from '@/lib/db/rqlite-client';
import { bundledIds, catalogIds, readBundledPackages, removedBundledIds } from '@/lib/widgets/bundled';
import { WIDGET_API_LEVEL, requiredApiLevel } from '@/lib/widgets/api-level';
import { clusterApiState, clusterCanRun } from '@/lib/widgets/cluster-level';

export interface SeedInstalled { source: 'github' | 'upload' | 'bundled'; version: string }
export type SeedAction = 'install' | 'upgrade' | 'skip' | 'defer';

/** What the cluster can run: the lowest voter API level, and the level the package version needs. */
export interface SeedCluster { minimum: number | null; requiresApi: number }

/**
 * What the seed does with one bundled package. Pure: a removed package stays removed, a zip upload is never touched,
 * and nothing is reinstalled at the same version or downgraded. A version that needs an API level above the cluster
 * minimum is deferred: writing it would leave the nodes that are behind unable to use the widget. Deferral does not
 * change what is installed, so the same decision is made again when the retry runs.
 */
export function seedDecision(
  bundledVersion: string, installed: SeedInstalled | null, removed: boolean,
  cluster: SeedCluster = { minimum: WIDGET_API_LEVEL, requiresApi: 1 },
): SeedAction {
  if (removed) return 'skip';
  let action: SeedAction;
  if (!installed) action = 'install';
  else if (installed.source === 'upload') return 'skip';
  else action = compareVersions(bundledVersion, installed.version) > 0 ? 'upgrade' : 'skip';
  if (action === 'skip') return 'skip';
  return clusterCanRun(cluster.requiresApi, cluster.minimum) ? action : 'defer';
}

/**
 * Does the installed copy differ from the one this image ships, at the same version? A package installed from an
 * intermediate build can carry a manifest that was fixed before the release (a credential kind that predates its
 * `view_permission`, a permission that changed level) and the version comparison alone would keep it forever. Only the
 * manifest is compared: the image's files are re-written on every install anyway, and a zip upload is the admin's.
 */
export function seedManifestChanged(
  bundled: PackageManifest,
  installed: { version: string; source: string; manifest: PackageManifest } | null,
): boolean {
  if (!installed || installed.source === 'upload') return false;
  if (compareVersions(bundled.version, installed.version) !== 0) return false;
  return JSON.stringify(manifestToJson(bundled)) !== JSON.stringify(manifestToJson(installed.manifest));
}

const g = globalThis as unknown as {
  __bosunSeedDeferred?: Map<string, string>;
  __bosunSeedRunning?: Promise<void>;
};

/** Log a deferral once per package and reason: the retry runs every few minutes and would otherwise repeat it. */
function logDeferred(id: string, version: string, requiresApi: number, minimum: number | null): void {
  const detail = `${version}: needs API ${requiresApi}, cluster minimum is ${minimum ?? 'unknown'}`;
  const seen = g.__bosunSeedDeferred ?? (g.__bosunSeedDeferred = new Map());
  if (seen.get(id) === detail) return;
  seen.set(id, detail);
  console.log(`[widgets] deferred ${id} ${detail}`);
}

const forgetDeferred = (id: string) => { g.__bosunSeedDeferred?.delete(id); };

/** One seed run at a time: the startup seed and a retry (rollout finish, leader timer) must not install in parallel. */
export function seedBundledPackages(): Promise<void> {
  if (g.__bosunSeedRunning) return g.__bosunSeedRunning;
  g.__bosunSeedRunning = seedOnce().finally(() => { g.__bosunSeedRunning = undefined; });
  return g.__bosunSeedRunning;
}

async function seedOnce(): Promise<void> {
  let installed = false;
  try {
    const { minimum } = await clusterApiState();
    const { packages, errors } = readBundledPackages();
    for (const e of errors) console.warn(`[widgets] bundled package skipped: ${e}`);
    const removed = await removedBundledIds();
    for (const { manifest, files } of packages) {
      try {
        const requiresApi = requiredApiLevel(manifest.requires);
        const have = await getInstalledPackage(manifest.id);
        const action = seedDecision(manifest.version, have?.pkg ?? null, removed.includes(manifest.id), { minimum, requiresApi });
        if (action === 'defer') { logDeferred(manifest.id, manifest.version, requiresApi, minimum); continue; }
        forgetDeferred(manifest.id);
        if (action === 'skip') {
          if (removed.includes(manifest.id) || !seedManifestChanged(manifest, have?.pkg ?? null)) continue;
          await installPackage({ manifest, files, source: 'bundled', allowSameOrOlder: true });
          installed = true;
          console.log(`[widgets] refreshed bundled package ${manifest.id} ${manifest.version}: the installed copy had an older manifest`);
          continue;
        }
        // The copy now comes from the image, so it is stored as `bundled` again: the settings page says
        // "preinstalled" (a stale `github` source would show a branch it no longer comes from) and the next
        // image keeps upgrading it.
        await installPackage({ manifest, files, source: 'bundled' });
        installed = true;
        console.log(`[widgets] ${action === 'upgrade' ? 'upgraded' : 'installed'} bundled package ${manifest.id} ${manifest.version}`);
      } catch (err) {
        console.warn(`[widgets] could not install bundled package ${manifest.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await adoptLegacyTypes(removed, minimum);
  } catch (err) {
    console.warn(`[widgets] bundled packages: ${err instanceof Error ? err.message : err}`);
  }
  // The migration turns old package secrets into entries and reads the installed manifests, so it must follow the
  // upgrade that brings the credential kinds. A deferred upgrade lands later, on the retry; running it once per process
  // as well keeps a secret that survived an earlier run from being missed.
  const g2 = globalThis as unknown as { __bosunCredentialMigrationRan?: boolean };
  if (installed || !g2.__bosunCredentialMigrationRan) {
    g2.__bosunCredentialMigrationRan = true;
    await migrateCredentials();
  }
}

/** Never throws: a failure here must not stop the dashboards from starting. */
async function migrateCredentials(): Promise<void> {
  const { migratePackageCredentials } = await import('@/lib/widgets/credentials');
  await migratePackageCredentials().catch(err => console.warn('[widgets] credential migration failed:', err instanceof Error ? err.message : err));
}

/**
 * Widget types an older Bosun seeded as built-ins are provided by packages now. A type that is on a dashboard but that no installed
 * package provides gets the package of the image that has it, even when that package is not preinstalled, so upgrading never breaks
 * an existing widget. Seeded types nobody uses and no package provides are dropped, so they are not offered with nothing behind them.
 */
async function adoptLegacyTypes(removed: string[], clusterMinimum: number | null): Promise<void> {
  const orphans = await rqlite.query(
    'SELECT type, (SELECT COUNT(*) FROM widgets w WHERE w.widget_type = c.type) FROM custom_widgets c WHERE c.package_id IS NULL AND c.builtin = 1');
  const inUse = new Set<string>((orphans.values ?? []).filter(r => Number(r[1]) > 0).map(r => String(r[0])));
  if (inUse.size) {
    const ids = catalogIds().filter(id => !bundledIds().includes(id) && !removed.includes(id));
    const { packages } = readBundledPackages(undefined, ids);
    for (const { manifest, files } of packages) {
      if (!manifest.widgets.some(w => inUse.has(w.type))) continue;
      const requiresApi = requiredApiLevel(manifest.requires);
      if (!clusterCanRun(requiresApi, clusterMinimum)) {
        logDeferred(manifest.id, manifest.version, requiresApi, clusterMinimum);
        continue;
      }
      try {
        if (await getInstalledPackage(manifest.id)) continue;
        await installPackage({ manifest, files, source: 'bundled' });
        forgetDeferred(manifest.id);
        console.log(`[widgets] installed package ${manifest.id} ${manifest.version}: dashboards already use its widgets`);
      } catch (err) {
        console.warn(`[widgets] could not install package ${manifest.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  await rqlite.execute('DELETE FROM custom_widgets WHERE package_id IS NULL AND builtin = 1 AND type NOT IN (SELECT widget_type FROM widgets)');
}

/**
 * Try the deferred bundled upgrades again. Called when a rolling update finishes (every node now runs the new build)
 * and by the leader's timer, so a cluster updated by hand catches up too. Never throws.
 */
export async function retryDeferredBundledPackages(): Promise<void> {
  try { await seedBundledPackages(); } catch { /* seedBundledPackages never throws */ }
}

const RETRY_EVERY_MS = 5 * 60 * 1000;

/** Retry deferred bundled upgrades every few minutes on the leader (one node writes; the rest read the change). */
export function startBundledSeedRetry(): void {
  const t = globalThis as unknown as { __bosunSeedRetryTimer?: NodeJS.Timeout; __bosunSeedRetryFirst?: NodeJS.Timeout };
  if (t.__bosunSeedRetryTimer || process.env.BOSUN_WIDGET_SEED_RETRY === '0') return;
  const tick = async () => {
    try {
      const status = await rqlite.getStatus() as { store?: { raft?: { state?: string } } } | null;
      if (status?.store?.raft?.state !== 'Leader') return;
      await seedBundledPackages();
    } catch (err) {
      console.warn('[widgets] deferred package retry failed:', err instanceof Error ? err.message : err);
    }
  };
  // Soon after boot (a cold start can leave a peer's level unknown until it answers), then every few minutes.
  t.__bosunSeedRetryFirst = setTimeout(() => { void tick(); }, 60_000);
  t.__bosunSeedRetryFirst.unref?.();
  t.__bosunSeedRetryTimer = setInterval(() => { void tick(); }, RETRY_EVERY_MS);
  t.__bosunSeedRetryTimer.unref?.();
}
