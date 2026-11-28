import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { hasPermission, requirePermission } from '@/lib/permissions/authorize';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadRuntimeData, loadWidgetSpec, RuntimeError } from '@/lib/widgets/runtime/execute';
import { filterRows, viewFilter } from '@/lib/widgets/runtime/resource-check';
import { widgetTypeApiProblem } from '@/lib/widgets/package-api-level';

/**
 * The data a package widget shows, for one server: GET /api/servers/:serverId/widget-data/:widgetType.
 * The same data the widget renders, for API keys. Widgets that name a `data.permission` need it here too;
 * `?force=1` re-runs the command, for callers who may refresh the server.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string; widgetType: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, widgetType } = await params;
  try {
    const loaded = await loadWidgetSpec(widgetType);
    if (!loaded) {
      const newer = await widgetTypeApiProblem(widgetType);
      return newer ? fail(newer, 422, 'NEWER_BOSUN_REQUIRED') : fail('Unknown widget type', 404, 'NOT_FOUND');
    }
    // A view limited to some stacks/containers gets only their rows (data.resources); no view at all is a 403.
    const view = await viewFilter(auth, loaded.spec.data.permission, serverId, loaded.spec.data.resources);
    if (!view) return (await requirePermission(auth, loaded.spec.data.permission, serverId))!;
    const force = new URL(request.url).searchParams.get('force') === '1' && await hasPermission(auth, 'servers.refresh', serverId);
    const rt = await loadRuntimeData(serverId, loaded, force);
    return ok(view === 'all' ? rt : { ...rt, data: filterRows(rt.data, loaded.spec.data.resources!, view) });
  } catch (error) {
    if (error instanceof RuntimeError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
