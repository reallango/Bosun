import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { createServerGroup, DuplicateNameError, listServerGroups } from '@/lib/permissions/groups';
import { validateServerGroupInput } from '@/lib/permissions/validate';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

/** List server groups with their member server ids. Full access, signed-in users only. */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ groups: await listServerGroups() });
  } catch (error) {
    console.error('Server group list error:', error);
    return internalError(error);
  }
}

/** Create a server group: { name, description?, server_ids? }. Groups are optional; a grant can name one server instead. */
export async function POST(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const parsed = validateServerGroupInput(body, true);
  if (!parsed.ok) return fail(parsed.error, 400, 'VALIDATION');
  try {
    const id = await createServerGroup(parsed.value);
    await logAudit({
      userId: auth.userId, action: AuditActions.SERVER_GROUP_CREATE, category: 'access', status: 'success',
      details: JSON.stringify({ name: parsed.value.name, servers: parsed.value.server_ids?.length ?? 0 }), ipAddress: clientIp(request) ?? undefined,
    });
    const group = (await listServerGroups()).find(g => g.id === id);
    return ok({ group }, { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateNameError) return fail(error.message, 409, 'NAME_TAKEN');
    if ((error as { code?: string })?.code === 'VALIDATION') return fail((error as Error).message, 400, 'VALIDATION');
    console.error('Server group create error:', error);
    return internalError(error);
  }
}
