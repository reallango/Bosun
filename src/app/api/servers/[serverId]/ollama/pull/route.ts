import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { startPull, listPullJobs, cancelPull, assertModelName } from '@/lib/ollama/actions';
import { requestPoll } from '@/lib/docker/actions';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

/** Progress of pulls on this server (the UI polls this while a pull runs). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const jobs = listPullJobs(serverId);
  // Right after a pull finishes, have the poller refresh the model list.
  if (jobs.some(j => j.finishedAt && Date.now() - j.finishedAt < 3000)) await requestPoll(serverId);
  return ok({ pulls: jobs });
}

/** Start pulling a model. Read + actions (operator) or higher; audited. Body: { model } */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const roleError = await requirePermission(auth, 'ollama.models.pull', serverId);
  if (roleError) return roleError;
  let body: { model?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const model = typeof body.model === 'string' ? body.model.trim() : body.model;
  try { assertModelName(model); } catch (e) { return failFrom(e); }
  const limit = consumeActionRateLimit(auth.userId);
  if (!limit.allowed) return fail('Too many actions, slow down', 429, 'RATE_LIMITED');
  try {
    const job = await startPull(serverId, model, auth.userId);
    await logAudit({ userId: auth.userId, serverId, action: AuditActions.OLLAMA_PULL, status: 'pending', details: JSON.stringify({ model }) });
    return ok({ pull: job }, { status: 202 });
  } catch (error) {
    return failFrom(error);
  }
}

/** Cancel a running pull: ?jobId=... Read + actions (operator) or higher. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  const roleError = await requirePermission(auth, 'ollama.models.pull', serverId);
  if (roleError) return roleError;
  const jobId = new URL(request.url).searchParams.get('jobId') || '';
  if (!cancelPull(serverId, jobId)) return fail('No running pull with that id', 404);
  await logAudit({ userId: auth.userId, serverId, action: AuditActions.OLLAMA_PULL, status: 'cancelled', details: JSON.stringify({ jobId }) });
  return ok({ cancelled: true });
}
