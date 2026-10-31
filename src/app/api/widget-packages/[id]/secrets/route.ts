import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { getInstalledPackage } from '@/lib/widgets/package-store';
import { deletePackageSecret, packageSecretStatus, setPackageSecret } from '@/lib/widgets/package-secrets';
import { requirePackageAdmin, requestIp } from '@/lib/widgets/package-routes';

/**
 * The secrets a widget package declares (a token it needs): Full access, signed-in users only. The values are never returned,
 * only whether each one is set. GET lists them, PUT { id, value } sets one, DELETE ?id= removes one.
 */
async function declared(id: string) {
  const found = await getInstalledPackage(id);
  return found ? found.pkg.manifest.secrets : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const list = await declared(id);
    if (!list) return fail('Package not found', 404, 'NOT_FOUND');
    const set = await packageSecretStatus(id, list.map(s => s.id));
    return ok({ secrets: list.map(s => ({ ...s, set: set[s.id] === true })) });
  } catch (error) {
    return failFrom(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const list = await declared(id);
    if (!list) return fail('Package not found', 404, 'NOT_FOUND');
    let body: { id?: unknown; value?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    if (typeof body.id !== 'string' || !list.some(s => s.id === body.id)) return fail('This package does not declare that secret', 400, 'UNKNOWN_SECRET');
    if (typeof body.value !== 'string') return fail('A value is required', 400);
    try { await setPackageSecret(id, body.id, body.value.trim()); } catch (e) { return fail(e instanceof Error ? e.message : 'Invalid value', 400); }
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_INSTALL, status: 'success', ipAddress: requestIp(request), details: `Set the secret ${body.id} of ${id}` });
    return ok({ set: true });
  } catch (error) {
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const list = await declared(id);
    if (!list) return fail('Package not found', 404, 'NOT_FOUND');
    const sid = new URL(request.url).searchParams.get('id') ?? '';
    if (!list.some(s => s.id === sid)) return fail('This package does not declare that secret', 400, 'UNKNOWN_SECRET');
    await deletePackageSecret(id, sid);
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_REMOVE, status: 'success', ipAddress: requestIp(request), details: `Removed the secret ${sid} of ${id}` });
    return ok({ set: false });
  } catch (error) {
    return failFrom(error);
  }
}
