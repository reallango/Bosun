/**
 * Install the bundled widget packages that are missing and upgrade the ones that were installed from
 * the image earlier. Runs once after the migrations. Packages installed from GitHub or a zip are the
 * admin's and are left alone; removed ones are not brought back. Never throws.
 */
import { compareVersions } from '@/lib/widgets/package-manifest';
import { getInstalledPackage, installPackage } from '@/lib/widgets/package-store';
import { rqlite } from '@/lib/db/rqlite-client';
import { bundledIds, catalogIds, readBundledPackages, removedBundledIds } from '@/lib/widgets/bundled';

export async function seedBundledPackages(): Promise<void> {
  try {
    const { packages, errors } = readBundledPackages();
    for (const e of errors) console.warn(`[widgets] bundled package skipped: ${e}`);
    const removed = await removedBundledIds();
    for (const { manifest, files } of packages) {
      if (removed.includes(manifest.id)) continue;
      try {
        const have = await getInstalledPackage(manifest.id);
        if (have && (have.pkg.source !== 'bundled' || compareVersions(manifest.version, have.pkg.version) <= 0)) continue;
        await installPackage({ manifest, files, source: 'bundled' });
        console.log(`[widgets] ${have ? 'upgraded' : 'installed'} bundled package ${manifest.id} ${manifest.version}`);
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
