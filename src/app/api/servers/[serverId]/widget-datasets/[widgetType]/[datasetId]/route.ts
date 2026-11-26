import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { serverVisible } from '@/lib/permissions/effective';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec, loadDataset, RuntimeError } from '@/lib/widgets/runtime/execute';
import { ParamError } from '@/lib/widgets/runtime/command';
import { filterRows, resolveTarget, TargetError, viewFilter } from '@/lib/widgets/runtime/resource-check';

/**
 * Load one dataset of a package widget: POST /api/servers/:serverId/widget-datasets/:widgetType/:datasetId with { args: {...} }.
 * A dataset is a read-only script the package declares for its screens (a list of images, the settings of one container). The
 * permission the package names for it is required, and the arguments are validated against the script's declaration.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string; widgetType: string; datasetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, widgetType, datasetId } = await params;
  try {
    const loaded = await loadWidgetSpec(widgetType);
    const ds = loaded?.spec.datasets?.[datasetId];
    if (!loaded || !ds) return fail('Unknown dataset', 404, 'NOT_FOUND');
    if (!(await serverVisible(auth, serverId))) return fail('Server not found', 404, 'NOT_FOUND');
    let body: { args?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    if (ds.target) {
      // About one stack/container (inspect, the files of a stack): checked against that one.
      const value = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>)[ds.target.param] : undefined;
      let resource;
      try { resource = await resolveTarget(serverId, loaded, ds.target, value); } catch (e) {
        if (e instanceof TargetError) return fail(e.message, e.status, e.code);
        throw e;
      }
      const denied = await requirePermission(auth, ds.permission, serverId, resource);
      if (denied) return denied;
      return ok(await loadDataset(serverId, loaded, datasetId, body.args), { headers: { 'Cache-Control': 'no-store' } });
    }
    // A list (ds.resources) is filtered for a view limited to some stacks/containers; anything else needs the whole server.
    const view = await viewFilter(auth, ds.permission, serverId, ds.resources);
    if (!view) return (await requirePermission(auth, ds.permission, serverId))!;
    const r = await loadDataset(serverId, loaded, datasetId, body.args);
    return ok(view === 'all' ? r : { ...r, data: filterRows(r.data, ds.resources!, view) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ParamError) return fail(error.message, 400, 'INVALID_PARAMS');
    if (error instanceof RuntimeError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
