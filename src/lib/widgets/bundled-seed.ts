/**
 * Install the bundled widget packages that are missing and upgrade the ones that were installed from
 * the image earlier. Runs once after the migrations. Packages installed from GitHub or a zip are the
 * admin's and are left alone; removed ones are not brought back. Never throws.
 */
import { compareVersions } from '@/lib/widgets/package-manifest';
import { getInstalledPackage, installPackage } from '@/lib/widgets/package-store';
import { readBundledPackages, removedBundledIds } from '@/lib/widgets/bundled';

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
  } catch (err) {
    console.warn(`[widgets] bundled packages: ${err instanceof Error ? err.message : err}`);
  }
}
