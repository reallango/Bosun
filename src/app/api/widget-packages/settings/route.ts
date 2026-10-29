import { NextRequest, NextResponse } from 'next/server';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { setConfig } from '@/lib/db/migrations';
import { ALLOWED_REFS, isAllowedRef } from '@/lib/widgets/package-source';
import { requirePackageAdmin, configuredRef, requestIp } from '@/lib/widgets/package-routes';

/** Choose the branch packages are listed from: { ref: "main" | "dev" }. */
export async function PUT(request: NextRequest) {
  const auth = await requirePackageAdmin(request);
  if (auth instanceof NextResponse) return auth;
  let body: { ref?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (!isAllowedRef(body.ref)) return fail(`ref must be one of: ${ALLOWED_REFS.join(', ')}`);
  try {
    await setConfig('widgets.source_ref', body.ref);
    await logAudit({ userId: auth.userId, action: AuditActions.WIDGET_PACKAGE_SETTINGS, status: 'success', ipAddress: requestIp(request), details: `source branch: ${body.ref}` });
    return ok({ ref: await configuredRef() });
  } catch (error) {
    return failFrom(error);
  }
}
