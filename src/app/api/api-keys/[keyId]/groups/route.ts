import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { groupIdsByPrincipal, setPrincipalGroups } from '@/lib/permissions/groups';
import { validateGroupIds } from '@/lib/permissions/validate';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Ctx = { params: Promise<{ keyId: string }> };

/** Replace the permission groups an API key holds: { group_ids: [...] }. Full access, signed-in users only. */
export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { keyId } = await params;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const ids = validateGroupIds(body.group_ids);
  if (!ids.ok) return fail(ids.error, 400, 'VALIDATION');
  try {
    const key = await rqlite.query('SELECT name FROM api_keys WHERE id = ?', [keyId]);
    if (!key.values?.length) return fail('API key not found', 404, 'NOT_FOUND');
    await setPrincipalGroups('api_key', keyId, ids.value);
    await logAudit({
      userId: auth.userId, action: AuditActions.ACCESS_GROUPS_SET, category: 'access', status: 'success',
      details: JSON.stringify({ api_key: key.values[0][0], group_ids: ids.value }), ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ group_ids: (await groupIdsByPrincipal('api_key')).get(keyId) || [] });
  } catch (error) {
    if ((error as { code?: string })?.code === 'VALIDATION') return fail((error as Error).message, 400, 'VALIDATION');
    console.error('API key groups error:', error);
    return internalError(error);
  }
}
