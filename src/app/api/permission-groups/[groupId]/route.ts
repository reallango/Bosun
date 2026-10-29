import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { deleteGroup, DuplicateNameError, getGroup, updateGroup } from '@/lib/permissions/groups';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { validateGroupInput } from '@/lib/permissions/validate';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Ctx = { params: Promise<{ groupId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { groupId } = await params;
  try {
    const group = await getGroup(groupId);
    return group ? ok({ group }) : fail('Permission group not found', 404, 'NOT_FOUND');
  } catch (error) {
    return internalError(error);
  }
}

/** Update { name?, description?, grants? }. Giving grants replaces all of the group's grants. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { groupId } = await params;

  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    const parsed = validateGroupInput(body, await registeredPermissionDefs(), false);
    if (!parsed.ok) return fail(parsed.error, 400, 'VALIDATION');
    if (!(await updateGroup(groupId, parsed.value))) return fail('Permission group not found', 404, 'NOT_FOUND');
    await logAudit({
      userId: auth.userId, action: AuditActions.PERMISSION_GROUP_UPDATE, category: 'access', status: 'success',
      details: JSON.stringify({ id: groupId, name: parsed.value.name, grants: parsed.value.grants?.length }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ group: await getGroup(groupId) });
  } catch (error) {
    if (error instanceof DuplicateNameError) return fail(error.message, 409, 'NAME_TAKEN');
    console.error('Permission group update error:', error);
    return internalError(error);
  }
}

/** Delete a group; the users and API keys that held it lose its grants. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { groupId } = await params;
  try {
    const before = await getGroup(groupId);
    if (!before || !(await deleteGroup(groupId))) return fail('Permission group not found', 404, 'NOT_FOUND');
    await logAudit({
      userId: auth.userId, action: AuditActions.PERMISSION_GROUP_DELETE, category: 'access', status: 'success',
      details: JSON.stringify({ id: groupId, name: before.name, users: before.user_count, api_keys: before.api_key_count }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ deleted: true });
  } catch (error) {
    console.error('Permission group delete error:', error);
    return internalError(error);
  }
}
