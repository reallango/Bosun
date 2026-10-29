import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fetchRemotePackage } from '@/lib/widgets/package-source';
import { installPackage } from '@/lib/widgets/package-store';
import { requirePackageAdmin, configuredRef, requestIp } from '@/lib/widgets/package-routes';

/** Install (or upgrade to the newer version of) a package from the configured branch: { id }. */
export async function POST(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  let body: { id?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return fail('id required');
  try {
    const ref = await configuredRef();
    const pkg = await fetchRemotePackage(ref, id);
    const result = await installPackage({ manifest: pkg.manifest, files: pkg.files, source: 'github', sourceRef: ref, userId: auth.userId });
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'success', ipAddress: requestIp(request),
      details: `${result.id} ${result.previousVersion ? `${result.previousVersion} -> ` : ''}${result.version} from github:${ref}` });
    return ok(result, { status: 201 });
  } catch (error) {
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'failure', ipAddress: requestIp(request),
      details: `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    return failFrom(error);
  }
}
