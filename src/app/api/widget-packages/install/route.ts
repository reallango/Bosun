import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fetchRemotePackage, manifestHashOf } from '@/lib/widgets/package-source';
import { installPackage } from '@/lib/widgets/package-store';
import { requirePackageAdmin, configuredRef, requestIp } from '@/lib/widgets/package-routes';

/**
 * Install (or upgrade to the newer version of) a package from the configured branch: { id, version, manifestHash }.
 * `version` and `manifestHash` are those of the package the admin reviewed (from the list of available packages); when the
 * branch now holds something else, the install is refused (409) so that nothing unreviewed is installed.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  let body: { id?: unknown; version?: unknown; manifestHash?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return fail('id required');
  const version = typeof body.version === 'string' ? body.version : '';
  const manifestHash = typeof body.manifestHash === 'string' ? body.manifestHash : '';
  if (!version || !/^[0-9a-f]{64}$/.test(manifestHash)) return fail('version and manifestHash of the reviewed package are required');
  try {
    const ref = await configuredRef();
    const pkg = await fetchRemotePackage(ref, id);
    if (pkg.manifest.version !== version || manifestHashOf(pkg.manifest) !== manifestHash) {
      return fail(`The package changed on the branch since it was reviewed (now version ${pkg.manifest.version}). Reload the list and review it again.`, 409, 'CHANGED_SINCE_REVIEW');
    }
    const result = await installPackage({ manifest: pkg.manifest, files: pkg.files, source: 'github', sourceRef: ref, userId: auth.userId });
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'success', ipAddress: requestIp(request),
      details: `${result.id} ${result.previousVersion ? `${result.previousVersion} -> ` : ''}${result.version} from github:${ref}${result.secretsCleared ? ' (stored secrets cleared: different source)' : ''}` });
    return ok(result, { status: 201 });
  } catch (error) {
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'failure', ipAddress: requestIp(request),
      details: `${id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    return failFrom(error);
  }
}
