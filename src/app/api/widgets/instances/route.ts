import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { visibleDashboards, visibleWidgets } from '@/lib/widgets/visibility';
import { listInstances, type InstanceRow } from '@/components/widgets/shared/screen-page';

/**
 * Every placement of one widget type that the caller may open: GET /api/widgets/instances?type=<widget_type>.
 *
 * A full-page screen can be switched to the same widget on another server without knowing this app's widget
 * packages: the caller only ever sees widgets whose server and data permission they hold, on dashboards they can
 * see. The same rules as the dashboard and widget routes apply.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const type = new URL(request.url).searchParams.get('type')?.trim();
  if (!type) return NextResponse.json({ error: { message: 'type is required' } }, { status: 400 });

  try {
    const rows = rowsToObjects(await rqlite.query(
      `SELECT w.id, w.widget_type, w.server_id, w.dashboard_id,
              s.name AS server_name,
              d.name AS dashboard_name, d.type AS dashboard_type, d.server_id AS dashboard_server_id
         FROM widgets w
         LEFT JOIN servers s ON s.id = w.server_id
         LEFT JOIN dashboards d ON d.id = w.dashboard_id
        WHERE w.widget_type = ? AND w.dashboard_id IS NOT NULL`,
      [type],
    )) as unknown as InstanceRow[];

    const widgets = await visibleWidgets(auth, rows);
    const dashboards = await visibleDashboards(auth, rows.map(r => ({
      id: r.dashboard_id, type: r.dashboard_type, server_id: r.dashboard_server_id,
    })));
    const visibleDashboardIds = new Set(dashboards.map(d => String(d.id)));

    return NextResponse.json(
      { data: { instances: listInstances(widgets, visibleDashboardIds) } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
