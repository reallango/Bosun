import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { deleteServerGroup, DuplicateNameError, listServerGroups, updateServerGroup } from '@/lib/permissions/groups';
import { validateServerGroupInput } from '@/lib/permissions/validate';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Ctx = { params: Promise<{ groupId: string }> };

/** Update { name?, description?, server_ids? }. Giving server_ids replaces the members. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { groupId } = await params;

  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const parsed = validateServerGroupInput(body, false);
  if (!parsed.ok) return fail(parsed.error, 400, 'VALIDATION');
  try {
    if (!(await updateServerGroup(groupId, parsed.value))) return fail('Server group not found', 404, 'NOT_FOUND');
    await logAudit({
      userId: auth.userId, action: AuditActions.SERVER_GROUP_UPDATE, category: 'access', status: 'success',
      details: JSON.stringify({ id: groupId, name: parsed.value.name, servers: parsed.value.server_ids?.length }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ group: (await listServerGroups()).find(g => g.id === groupId) });
  } catch (error) {
    if (error instanceof DuplicateNameError) return fail(error.message, 409, 'NAME_TAKEN');
    if ((error as { code?: string })?.code === 'VALIDATION') return fail((error as Error).message, 400, 'VALIDATION');
    console.error('Server group update error:', error);
    return internalError(error);
  }
}

/** Delete a server group; permission grants that were scoped to it are removed with it. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { groupId } = await params;
  try {
    const before = (await listServerGroups()).find(g => g.id === groupId);
    if (!before || !(await deleteServerGroup(groupId))) return fail('Server group not found', 404, 'NOT_FOUND');
    await logAudit({
      userId: auth.userId, action: AuditActions.SERVER_GROUP_DELETE, category: 'access', status: 'success',
      details: JSON.stringify({ id: groupId, name: before.name }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ deleted: true });
  } catch (error) {
    console.error('Server group delete error:', error);
    return internalError(error);
  }
}
