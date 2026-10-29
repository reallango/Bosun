import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { createGroup, DuplicateNameError, getGroup, listGroups } from '@/lib/permissions/groups';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { validateGroupInput } from '@/lib/permissions/validate';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

/** List permission groups with their grants and member counts. Full access, signed-in users only. */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ groups: await listGroups() });
  } catch (error) {
    console.error('Permission group list error:', error);
    return internalError(error);
  }
}

/**
 * Create a permission group: { name, description?, grants?: [{ permission, scope?: { type: 'all' | 'server' | 'server_group', id? } }] }.
 * A grant without a scope is for all servers.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    const parsed = validateGroupInput(body, await registeredPermissionDefs(), true);
    if (!parsed.ok) return fail(parsed.error, 400, 'VALIDATION');
    const id = await createGroup(parsed.value, auth.userId);
    await logAudit({
      userId: auth.userId, action: AuditActions.PERMISSION_GROUP_CREATE, category: 'access', status: 'success',
      details: JSON.stringify({ name: parsed.value.name, grants: parsed.value.grants?.length ?? 0 }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ group: await getGroup(id) }, { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateNameError) return fail(error.message, 409, 'NAME_TAKEN');
    console.error('Permission group create error:', error);
    return internalError(error);
  }
}
