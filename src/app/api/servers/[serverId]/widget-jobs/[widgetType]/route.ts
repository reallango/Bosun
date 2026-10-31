import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { getJob, latestJob, viewOf } from '@/lib/widgets/jobs/store';

/**
 * The state of a package widget's job on a server: GET /api/servers/:serverId/widget-jobs/:widgetType, the newest
 * job (running or finished), or `?id=<jobId>` for a specific one. `job` is null when there has been none. The same
 * permission as the widget's data is needed. Jobs are started through the widget-actions endpoint (it answers 202).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string; widgetType: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, widgetType } = await params;
  try {
    const loaded = await loadWidgetSpec(widgetType);
    if (!loaded) return fail('Unknown widget type', 404, 'NOT_FOUND');
    if (loaded.spec.data.permission) {
      const denied = await requirePermission(auth, loaded.spec.data.permission, serverId);
      if (denied) return denied;
    }
    const id = new URL(request.url).searchParams.get('id');
    const job = id ? await getJob(id) : await latestJob(serverId, widgetType);
    if (job && (job.serverId !== serverId || job.widgetType !== widgetType)) return ok({ job: null });
    return ok({ job: job ? viewOf(job) : null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
