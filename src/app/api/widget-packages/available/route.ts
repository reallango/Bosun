import { NextRequest, NextResponse } from 'next/server';
import { ok, failFrom } from '@/lib/api/response';
import { listRemotePackagesCached, manifestHashOf } from '@/lib/widgets/package-source';
import { compareVersions } from '@/lib/widgets/package-manifest';
import { listInstalledPackages, sameOrigin } from '@/lib/widgets/package-store';
import { packageSecretStatus } from '@/lib/widgets/package-secrets';
import { reviewPackage } from '@/lib/widgets/runtime/review';
import { requirePackageAdmin, configuredRef } from '@/lib/widgets/package-routes';

/**
 * Packages offered by the configured branch of the Bosun repository (`widgets/` folder), with
 * whether each is installed and whether a newer version is available. `?refresh=1` skips the 5-minute cache.
 */
export async function GET(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const ref = await configuredRef();
    const listing = await listRemotePackagesCached(ref, new URL(request.url).searchParams.get('refresh') === '1');
    const installedList = await listInstalledPackages();
    const installed = new Map(installedList.map(p => [p.id, p.version]));
    // Installing over a package from another source or author deletes the secrets stored for it: say so in the review.
    const clears = new Set<string>();
    for (const p of installedList) {
      const offered = listing.packages.find(x => x.id === p.id);
      if (!offered || sameOrigin(p, { source: 'github', author: offered.manifest.author })) continue;
      const status = await packageSecretStatus(p.id, p.manifest.secrets.map(s => s.id));
      if (Object.values(status).some(Boolean)) clears.add(p.id);
    }
    const packages = listing.packages.map(p => {
      const have = installed.get(p.id) ?? null;
      return {
        // What the install request must send back, so the package installed is the one reviewed here.
        manifestHash: manifestHashOf(p.manifest), secretsWillBeCleared: clears.has(p.id),
        id: p.id, name: p.manifest.name, version: p.manifest.version, description: p.manifest.description, author: p.manifest.author,
        widgetTypes: p.manifest.widgets.map(w => w.type), permissions: p.manifest.permissions.map(x => x.id),
        installedVersion: have, upgradable: have !== null && compareVersions(p.manifest.version, have) > 0,
        installable: p.installable, blockedReason: p.blockedReason,
        review: reviewPackage(p.manifest),
      };
    });
    return ok({ ref, packages, skipped: listing.skipped });
  } catch (error) {
    return failFrom(error);
  }
}
