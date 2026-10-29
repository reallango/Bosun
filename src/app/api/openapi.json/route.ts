import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { CATALOG } from '@/lib/permissions/catalog';
import { failFrom } from '@/lib/api/response';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { buildOpenApi, type OpenApiWidget } from '@/lib/widgets/runtime/openapi';

/** OpenAPI document of the API, including every installed package widget's data and actions. Any signed-in caller. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = rowsToObjects(await rqlite.query('SELECT type, display_name FROM custom_widgets WHERE package_id IS NOT NULL AND spec IS NOT NULL AND enabled = 1 ORDER BY display_name'));
    const labels: Record<string, string> = Object.fromEntries([...CATALOG, ...(await registeredPermissionDefs())].map(p => [p.id, p.label]));
    const widgets: OpenApiWidget[] = [];
    for (const r of rows) {
      const loaded = await loadWidgetSpec(String(r.type));
      if (loaded) widgets.push({ type: loaded.type, packageId: loaded.packageId, displayName: String(r.display_name), spec: loaded.spec, permissionLabels: labels });
    }
    const origin = new URL(request.url).origin;
    return NextResponse.json(buildOpenApi(widgets, origin), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
