import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { getJob } from '@/lib/widgets/jobs/store';
import { dismissedJobIds, setJobDismissed } from '@/lib/widgets/jobs/task-state';
import { mayUse, nameMaps, toTask } from '@/lib/widgets/jobs/tasks';

/** One task with its steps and the log of its script (secrets removed): GET /api/widget-jobs/:jobId. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { jobId } = await params;
  try {
    const j = await getJob(jobId);
    if (!j || !(await mayUse(auth, j))) return fail('Task not found', 404, 'NOT_FOUND');
    const task = await toTask(j, auth, await nameMaps(), (await dismissedJobIds(auth.userId)).has(j.id));
    return ok({ task: { ...task, steps: j.steps }, log: j.log }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}

/** Dismiss a finished task from this person's bell (or put it back): PATCH { dismissed: boolean }. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { jobId } = await params;
  let body: { dismissed?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (typeof body.dismissed !== 'boolean') return fail('dismissed must be true or false');
  try {
    const j = await getJob(jobId);
    if (!j || !(await mayUse(auth, j))) return fail('Task not found', 404, 'NOT_FOUND');
    await setJobDismissed(auth.userId, jobId, body.dismissed);
    return ok({ dismissed: body.dismissed }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
