import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { getJob } from '@/lib/widgets/jobs/store';
import { cancelJob } from '@/lib/widgets/jobs/runtime';

/**
 * Cancel a running job: POST /api/servers/:serverId/widget-jobs/:widgetType/:jobId/cancel. It needs the permission of
 * the action that started the job. The script is stopped on the host (best effort) and the job ends as `cancelled`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string; widgetType: string; jobId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, widgetType, jobId } = await params;
  try {
    const job = await getJob(jobId);
    if (!job || job.serverId !== serverId || job.widgetType !== widgetType) return fail('Job not found', 404, 'NOT_FOUND');
    const loaded = await loadWidgetSpec(widgetType);
    const action = loaded?.spec.actions.find(a => a.id === job.actionId);
    if (!loaded || !action) return fail('Job not found', 404, 'NOT_FOUND');
    const denied = await requirePermission(auth, action.permission, serverId);
    if (denied) return denied;
    const accepted = await cancelJob(jobId);
    await logAudit({
      userId: auth.userId, serverId, action: AuditActions.WIDGET_ACTION, status: accepted ? 'success' : 'failure',
      details: JSON.stringify({ widget: widgetType, action: job.actionId, job: jobId, cancel: true }).slice(0, 900), ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0],
    });
    if (!accepted) return fail('The job is not running', 409, 'NOT_RUNNING');
    return ok({ cancelRequested: true });
  } catch (error) {
    return failFrom(error);
  }
}
