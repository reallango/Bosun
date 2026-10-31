import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { getJob, getOriginEnc } from '@/lib/widgets/jobs/store';
import { decryptOrigin } from '@/lib/widgets/jobs/origin';
import { mayUse } from '@/lib/widgets/jobs/tasks';

/**
 * Where a task came from, to reopen its screen: GET /api/widget-jobs/:jobId/origin. Only the person who started it (or a Full access
 * user) gets this. The values have their secrets replaced by placeholders that only the server can turn back into the real value.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { jobId } = await params;
  try {
    const j = await getJob(jobId);
    if (!j || !(await mayUse(auth, j)) || (j.userId !== auth.userId && auth.role !== 'admin')) return fail('Task not found', 404, 'NOT_FOUND');
    const origin = decryptOrigin(await getOriginEnc(jobId));
    if (!origin || !j.widgetId) return fail('That task has no saved screen', 404, 'NO_ORIGIN');
    return ok({ jobId, widgetId: j.widgetId, widgetType: j.widgetType, serverId: j.serverId, screenId: origin.screenId, context: origin.context, values: origin.values }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
