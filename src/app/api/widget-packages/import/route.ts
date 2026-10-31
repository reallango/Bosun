import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { readZip, ZipError } from '@/lib/widgets/zip';
import { validateManifest, validateFiles } from '@/lib/widgets/package-manifest';
import { reservedPackageNames } from '@/lib/widgets/system-packages';
import { installPackage, getInstalledPackage } from '@/lib/widgets/package-store';
import { reviewPackage } from '@/lib/widgets/runtime/review';
import { requirePackageAdmin, requestIp } from '@/lib/widgets/package-routes';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Import a package zip: the request body is the zip itself (Content-Type: application/zip).
 * `manifest.json` may be at the root or inside one top-level folder. `?replace=1` allows
 * re-importing the same or an older version over an installed one.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_UPLOAD_BYTES) return fail('The zip is larger than 8 MB', 413);
    const buf = Buffer.from(await request.arrayBuffer());
    if (!buf.length) return fail('Send the zip file as the request body');
    if (buf.length > MAX_UPLOAD_BYTES) return fail('The zip is larger than 8 MB', 413);

    let entries: Record<string, Buffer>;
    try { entries = readZip(buf); } catch (err) {
      if (err instanceof ZipError) return fail(err.message, 422, 'INVALID_ZIP');
      throw err;
    }
    // Allow the common "zip of a folder" layout: everything under one top-level directory.
    const names = Object.keys(entries);
    const tops = new Set(names.map(n => (n.includes('/') ? n.split('/')[0] : '')));
    if (!names.includes('manifest.json') && tops.size === 1 && !tops.has('')) {
      const prefix = `${Array.from(tops)[0]}/`;
      if (names.includes(`${prefix}manifest.json`)) {
        entries = Object.fromEntries(Object.entries(entries).map(([n, d]) => [n.slice(prefix.length), d]));
      }
    }
    if (!entries['manifest.json']) return fail('The zip has no manifest.json', 422, 'NO_MANIFEST');

    let raw: unknown;
    try { raw = JSON.parse(entries['manifest.json'].toString('utf8')); } catch { return fail('manifest.json is not valid JSON', 422, 'INVALID_MANIFEST'); }
    const { types, ids } = reservedPackageNames();
    const manifest = validateManifest(raw, { reservedTypes: types, reservedIds: ids });
    if (!manifest.ok) return fail(manifest.error, 422, 'INVALID_MANIFEST');
    const rest = { ...entries };
    delete rest['manifest.json'];
    const files = validateFiles(rest);
    if (!files.ok) return fail(files.error, 422, 'INVALID_FILES');

    const query = new URL(request.url).searchParams;
    // dry_run=1: validate and describe what the package can run, without installing it.
    if (query.get('dry_run') === '1') {
      const have = await getInstalledPackage(manifest.value.id);
      return ok({ id: manifest.value.id, name: manifest.value.name, version: manifest.value.version, installedVersion: have?.pkg.version ?? null, review: reviewPackage(manifest.value, files.value) });
    }
    const replace = query.get('replace') === '1';
    const result = await installPackage({ manifest: manifest.value, files: files.value, source: 'upload', userId: auth.userId, allowSameOrOlder: replace });
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'success', ipAddress: requestIp(request),
      details: `${result.id} ${result.previousVersion ? `${result.previousVersion} -> ` : ''}${result.version} from zip upload` });
    return ok(result, { status: 201 });
  } catch (error) {
    return failFrom(error);
  }
}
