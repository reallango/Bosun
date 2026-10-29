import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { removePackage } from '@/lib/widgets/package-store';
import { reservedPackageNames } from '@/lib/widgets/system-packages';
import { requirePackageAdmin, requestIp } from '@/lib/widgets/package-routes';

/**
 * Remove an installed package: DELETE /api/widget-packages/:id. Refused while its widgets are on a
 * dashboard unless `?remove_widgets=1`. System widgets are built in and cannot be removed.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (reservedPackageNames().ids.includes(id)) return fail('System widgets are built in and cannot be removed', 403, 'SYSTEM_PACKAGE');
  try {
    const r = await removePackage(id, new URL(request.url).searchParams.get('remove_widgets') === '1');
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_REMOVE, status: 'success', ipAddress: requestIp(request),
      details: `${id}${r.removedWidgets ? ` (removed ${r.removedWidgets} widgets)` : ''}` });
    return ok(r);
  } catch (error) {
    return failFrom(error);
  }
}
