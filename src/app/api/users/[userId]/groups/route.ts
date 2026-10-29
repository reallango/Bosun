import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { groupIdsByPrincipal, setPrincipalGroups } from '@/lib/permissions/groups';
import { validateGroupIds } from '@/lib/permissions/validate';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Ctx = { params: Promise<{ userId: string }> };

/** Replace the permission groups a user holds: { group_ids: [...] }. Full access, signed-in users only. */
export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { userId } = await params;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const ids = validateGroupIds(body.group_ids);
  if (!ids.ok) return fail(ids.error, 400, 'VALIDATION');
  try {
    const user = await rqlite.query('SELECT username FROM users WHERE id = ?', [userId]);
    if (!user.values?.length) return fail('User not found', 404, 'NOT_FOUND');
    await setPrincipalGroups('user', userId, ids.value);
    await logAudit({
      userId: auth.userId, action: AuditActions.ACCESS_GROUPS_SET, category: 'access', status: 'success',
      details: JSON.stringify({ user: user.values[0][0], group_ids: ids.value }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ group_ids: (await groupIdsByPrincipal('user')).get(userId) || [] });
  } catch (error) {
    if ((error as { code?: string })?.code === 'VALIDATION') return fail((error as Error).message, 400, 'VALIDATION');
    console.error('User groups error:', error);
    return internalError(error);
  }
}
