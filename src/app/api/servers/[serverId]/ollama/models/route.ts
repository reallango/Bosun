import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { deleteModel, assertModelName } from '@/lib/ollama/actions';
import { requestPoll } from '@/lib/docker/actions';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * Delete a model. Read + actions (operator) or higher. Body: { name, confirm: true } (the UI asks the
 * user to type the model name before sending confirm).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const roleError = await requirePermission(auth, 'ollama.models.delete', serverId);
  if (roleError) return roleError;
  let body: { name?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const name = body.name;
  try { assertModelName(name); } catch (e) { return failFrom(e); }
  if (body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');
  try {
    const r = await deleteModel(serverId, name);
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.OLLAMA_DELETE, status: r.success ? 'success' : 'failure',
      details: JSON.stringify({ model: name, message: r.message }) });
    await requestPoll(serverId);
    return r.success ? ok(r) : fail(r.message, 502, 'ACTION_FAILED');
  } catch (error) {
    return failFrom(error);
  }
}
