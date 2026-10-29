import { NextRequest, NextResponse } from 'next/server';
import { fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { getInstalledPackage } from '@/lib/widgets/package-store';
import { manifestToJson } from '@/lib/widgets/package-manifest';
import { reservedPackageNames } from '@/lib/widgets/system-packages';
import { writeZip } from '@/lib/widgets/zip';
import { requirePackageAdmin, requestIp } from '@/lib/widgets/package-routes';

/** Download an installed package as a zip (manifest.json plus its files), importable on another Bosun. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (reservedPackageNames().ids.includes(id)) return fail('System widgets are built in and have no package to export', 400, 'SYSTEM_PACKAGE');
  try {
    const found = await getInstalledPackage(id);
    if (!found) return fail('Package not found', 404, 'NOT_FOUND');
    const zip = writeZip({ 'manifest.json': JSON.stringify(manifestToJson(found.pkg.manifest), null, 2) + '\n', ...found.files });
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_EXPORT, status: 'success', ipAddress: requestIp(request), details: `${id} ${found.pkg.version}` });
    return new NextResponse(new Uint8Array(zip), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${id}-${found.pkg.version}.zip"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return failFrom(error);
  }
}
