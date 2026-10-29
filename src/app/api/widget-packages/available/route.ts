import { NextRequest, NextResponse } from 'next/server';
import { ok, failFrom } from '@/lib/api/response';
import { listRemotePackagesCached } from '@/lib/widgets/package-source';
import { compareVersions } from '@/lib/widgets/package-manifest';
import { listInstalledPackages } from '@/lib/widgets/package-store';
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
    const installed = new Map((await listInstalledPackages()).map(p => [p.id, p.version]));
    const packages = listing.packages.map(p => {
      const have = installed.get(p.id) ?? null;
      return {
        id: p.id, name: p.manifest.name, version: p.manifest.version, description: p.manifest.description, author: p.manifest.author,
        widgetTypes: p.manifest.widgets.map(w => w.type), permissions: p.manifest.permissions.map(x => x.id),
        installedVersion: have, upgradable: have !== null && compareVersions(p.manifest.version, have) > 0,
        review: reviewPackage(p.manifest),
      };
    });
    return ok({ ref, packages, skipped: listing.skipped });
  } catch (error) {
    return failFrom(error);
  }
}
