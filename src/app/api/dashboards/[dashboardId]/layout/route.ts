import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { isGridBreakpoint, type GridBreakpoint, type GridRect } from '@/types/dashboard';

/**
 * PATCH /api/dashboards/:dashboardId/layout
 *
 * Body: { breakpoint?: 'xxl'|'xl'|'lg'|'md'|'sm'|'xs'|'xxs', layout: [{ widgetId, x, y, w, h }] }
 *   - breakpoint omitted (legacy body) or 'lg': written to widgets.grid_x/grid_y/grid_w/grid_h
 *   - any other breakpoint: merged into widgets.layouts JSON under that key
 * Every widgetId must belong to the dashboard, otherwise 400 and nothing is written.
 */

const MAX_COORD = 10_000;

function badRequest(message: string) {
  return NextResponse.json({ error: { message } }, { status: 400 });
}

function parseItem(raw: unknown): ({ widgetId: string } & GridRect) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.widgetId !== 'string' || !r.widgetId) return null;
  const nums = [r.x, r.y, r.w, r.h];
  if (!nums.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COORD)) return null;
  if ((r.w as number) < 1 || (r.h as number) < 1) return null;
  return { widgetId: r.widgetId, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

function parseLayouts(value: unknown): Record<string, GridRect> {
  if (!value) return {};
  if (typeof value === 'object') return { ...(value as Record<string, GridRect>) };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'operator');
  if (roleError) return roleError;
  const { dashboardId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const { breakpoint: rawBreakpoint, layout } = (body ?? {}) as { breakpoint?: unknown; layout?: unknown };

  const breakpoint: GridBreakpoint = rawBreakpoint === undefined || rawBreakpoint === null ? 'lg' : (rawBreakpoint as GridBreakpoint);
  if (!isGridBreakpoint(breakpoint)) return badRequest('Unknown breakpoint');
  if (!Array.isArray(layout)) return badRequest('layout must be array');
  if (layout.length > 500) return badRequest('layout too large');

  const items = layout.map(parseItem);
  if (items.some(i => i === null)) return badRequest('Each layout item needs widgetId and non-negative integer x, y, w, h');
  const valid = items as ({ widgetId: string } & GridRect)[];
  if (valid.length === 0) return NextResponse.json({ data: { success: true, updated: 0 } });

  try {
    const existing = await rqlite.query('SELECT * FROM widgets WHERE dashboard_id = ?', [dashboardId]);
    const rows = rowsToObjects(existing);
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const foreign = valid.filter(i => !byId.has(i.widgetId)).map(i => i.widgetId);
    if (foreign.length) return badRequest(`Widgets not on this dashboard: ${foreign.join(', ')}`);

    let stmts: { sql: string; params: unknown[] }[];
    if (breakpoint === 'lg') {
      stmts = valid.map(i => ({
        sql: 'UPDATE widgets SET grid_x = ?, grid_y = ?, grid_w = ?, grid_h = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?',
        params: [i.x, i.y, i.w, i.h, i.widgetId, dashboardId],
      }));
    } else {
      if (rows.length > 0 && !('layouts' in rows[0])) {
        return NextResponse.json(
          { error: { message: 'Per-breakpoint layouts are not available until the widgets.layouts migration has run' } },
          { status: 409 }
        );
      }
      stmts = valid.map(i => {
        const merged = parseLayouts(byId.get(i.widgetId)?.layouts);
        delete merged.lg;
        merged[breakpoint] = { x: i.x, y: i.y, w: i.w, h: i.h };
        return {
          sql: 'UPDATE widgets SET layouts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?',
          params: [JSON.stringify(merged), i.widgetId, dashboardId],
        };
      });
    }

    await rqlite.executeBatch(stmts);
    return NextResponse.json({ data: { success: true, breakpoint, updated: stmts.length } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
