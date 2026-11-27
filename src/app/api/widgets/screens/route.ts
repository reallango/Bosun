import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { hasPermission } from '@/lib/permissions/authorize';
import { fillTemplate } from '@/lib/widgets/runtime/spec';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { visibleDashboards, visibleWidgets } from '@/lib/widgets/visibility';

/**
 * Full-page screens a caller may open, for the command palette:
 * GET /api/widgets/screens.
 *
 * The same rules as the dashboard and instance routes apply: only widgets whose server and data permission the caller
 * holds, on dashboards they can see. A screen is listed only when a menu entry or a screen action opens it, and only
 * when the caller may use that entry (its permission, when it has one).
 */

interface ScreenRow {
  id: string;
  widget_type: string;
  server_id: string;
  server_name?: string | null;
  dashboard_id: string | null;
  dashboard_name?: string | null;
  dashboard_type?: string | null;
  dashboard_server_id?: string | null;
}

interface ScreenLink {
  widgetId: string;
  widgetType: string;
  screenId: string;
  title: string;
  serverId: string;
  serverName: string | null;
  dashboardId: string;
  dashboardName: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const rows = rowsToObjects(await rqlite.query(
      `SELECT w.id, w.widget_type, w.server_id, w.dashboard_id,
              s.name AS server_name,
              d.name AS dashboard_name, d.type AS dashboard_type, d.server_id AS dashboard_server_id
         FROM widgets w
         LEFT JOIN servers s ON s.id = w.server_id
         LEFT JOIN dashboards d ON d.id = w.dashboard_id
        WHERE w.dashboard_id IS NOT NULL`,
    )) as unknown as ScreenRow[];

    const widgets = await visibleWidgets(auth, rows);
    const dashboards = await visibleDashboards(auth, rows.map(r => ({
      id: r.dashboard_id, type: r.dashboard_type, server_id: r.dashboard_server_id,
    })));
    const visibleDashboardIds = new Set(dashboards.map(d => String(d.id)));

    const specs = new Map<string, Awaited<ReturnType<typeof loadWidgetSpec>>>();
    const screens: ScreenLink[] = [];
    const seen = new Set<string>();

    for (const row of widgets) {
      const dashboardId = row.dashboard_id;
      if (!dashboardId || !visibleDashboardIds.has(String(dashboardId))) continue;

      if (!specs.has(row.widget_type)) specs.set(row.widget_type, await loadWidgetSpec(row.widget_type));
      const spec = specs.get(row.widget_type)?.spec;
      if (!spec?.screens) continue;

      const pageScreens = new Set<string>();
      for (const entry of spec.menu ?? []) {
        if (spec.screens[entry.screen]?.kind === 'page' && (!entry.permission || await hasPermission(auth, entry.permission, row.server_id))) {
          pageScreens.add(entry.screen);
        }
      }
      for (const action of spec.actions) {
        if (action.kind === 'screen' && action.screen && spec.screens[action.screen]?.kind === 'page'
          && await hasPermission(auth, action.permission, row.server_id)) {
          pageScreens.add(action.screen);
        }
      }

      for (const screenId of Array.from(pageScreens)) {
        const key = `${row.id}:${screenId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const screen = spec.screens[screenId];
        const context = {
          server: { id: row.server_id, name: row.server_name ?? '' },
          dashboard: { id: dashboardId, name: row.dashboard_name ?? '' },
        };
        const title = fillTemplate(screen.title, context).trim()
          || fillTemplate(screen.title, {}).replace(/\{[^}]*\}/g, '').trim()
          || screenId;
        screens.push({
          widgetId: row.id,
          widgetType: row.widget_type,
          screenId,
          title,
          serverId: row.server_id,
          serverName: row.server_name ?? null,
          dashboardId: String(dashboardId),
          dashboardName: row.dashboard_name ?? null,
        });
      }
    }

    screens.sort((a, b) => a.title.localeCompare(b.title) || (a.serverName ?? '').localeCompare(b.serverName ?? '') || a.widgetId.localeCompare(b.widgetId));
    return NextResponse.json({ data: { screens } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
