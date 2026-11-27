/**
 * Install the bundled widget packages that are missing and upgrade the ones the image ships a newer version of.
 * Runs once after the migrations. A package installed from GitHub comes from this same repository, so a newer
 * bundled version replaces it and its secrets are kept; a zip upload is the admin's and is left alone. Removed
 * ones are not brought back. Never throws.
 */
import { compareVersions } from '@/lib/widgets/package-manifest';
import { getInstalledPackage, installPackage } from '@/lib/widgets/package-store';
import { rqlite } from '@/lib/db/rqlite-client';
import { bundledIds, catalogIds, readBundledPackages, removedBundledIds } from '@/lib/widgets/bundled';

export interface SeedInstalled { source: 'github' | 'upload' | 'bundled'; version: string }
export type SeedAction = 'install' | 'upgrade' | 'skip';

/**
 * What the seed does with one bundled package. Pure: a removed package stays removed, a zip upload is never touched,
 * and nothing is reinstalled at the same version or downgraded.
 */
export function seedDecision(bundledVersion: string, installed: SeedInstalled | null, removed: boolean): SeedAction {
  if (removed) return 'skip';
  if (!installed) return 'install';
  if (installed.source === 'upload') return 'skip';
  return compareVersions(bundledVersion, installed.version) > 0 ? 'upgrade' : 'skip';
}

export async function seedBundledPackages(): Promise<void> {
  try {
    const { packages, errors } = readBundledPackages();
    for (const e of errors) console.warn(`[widgets] bundled package skipped: ${e}`);
    const removed = await removedBundledIds();
    for (const { manifest, files } of packages) {
      try {
        const have = await getInstalledPackage(manifest.id);
        const action = seedDecision(manifest.version, have?.pkg ?? null, removed.includes(manifest.id));
        if (action === 'skip') continue;
        // The copy now comes from the image, so it is stored as `bundled` again: the settings page says
        // "preinstalled" (a stale `github` source would show a branch it no longer comes from) and the next
        // image keeps upgrading it.
        await installPackage({ manifest, files, source: 'bundled' });
        console.log(`[widgets] ${action === 'upgrade' ? 'upgraded' : 'installed'} bundled package ${manifest.id} ${manifest.version}`);
      } catch (err) {
        console.warn(`[widgets] could not install bundled package ${manifest.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await adoptLegacyTypes(removed);
  } catch (err) {
    console.warn(`[widgets] bundled packages: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Widget types an older Bosun seeded as built-ins are provided by packages now. A type that is on a dashboard but that no installed
 * package provides gets the package of the image that has it, even when that package is not preinstalled, so upgrading never breaks
 * an existing widget. Seeded types nobody uses and no package provides are dropped, so they are not offered with nothing behind them.
 */
async function adoptLegacyTypes(removed: string[]): Promise<void> {
  const orphans = await rqlite.query(
    'SELECT type, (SELECT COUNT(*) FROM widgets w WHERE w.widget_type = c.type) FROM custom_widgets c WHERE c.package_id IS NULL AND c.builtin = 1');
  const inUse = new Set<string>((orphans.values ?? []).filter(r => Number(r[1]) > 0).map(r => String(r[0])));
  if (inUse.size) {
    const ids = catalogIds().filter(id => !bundledIds().includes(id) && !removed.includes(id));
    const { packages } = readBundledPackages(undefined, ids);
    for (const { manifest, files } of packages) {
      if (!manifest.widgets.some(w => inUse.has(w.type))) continue;
      try {
        if (await getInstalledPackage(manifest.id)) continue;
        await installPackage({ manifest, files, source: 'bundled' });
        console.log(`[widgets] installed package ${manifest.id} ${manifest.version}: dashboards already use its widgets`);
      } catch (err) {
        console.warn(`[widgets] could not install package ${manifest.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  await rqlite.execute('DELETE FROM custom_widgets WHERE package_id IS NULL AND builtin = 1 AND type NOT IN (SELECT widget_type FROM widgets)');
}
