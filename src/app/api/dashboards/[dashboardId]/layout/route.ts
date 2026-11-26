import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { isGridBreakpoint, type GridBreakpoint, type GridRect, type LayoutUpdateMode, type WidgetLayouts } from '@/types/dashboard';
import { STACKED_BREAKPOINTS, applyLayoutEdit, applyLayoutEverywhere, resetLayoutAt, type LayoutEditResult } from '@/lib/widget-sizes';

/**
 * PATCH /api/dashboards/:dashboardId/layout
 *
 * Body: { breakpoint?: 'xxl'|'xl'|'lg'|'md'|'sm'|'xs'|'xxs', layout?: [{ widgetId, x, y, w, h }], mode?: 'edit'|'everywhere'|'reset' }
 *   - edit (default; breakpoint omitted = 'lg', the legacy body): the size's arrangement is saved in widgets.layouts under
 *     that key and, on multi-column sizes, also becomes the base layout (widgets.grid_*) that sizes without their own
 *     arrangement derive from. Phone (stacked) sizes only save their own arrangement.
 *   - everywhere: the arrangement becomes the base and every other size's arrangement is dropped (multi-column sizes only).
 *   - reset: drops the size's own arrangement on every widget of the dashboard, so it follows the base again (no layout).
 * Every widgetId must belong to the dashboard, otherwise 400 and nothing is written.
 */

const MAX_COORD = 10_000;
const MODES: LayoutUpdateMode[] = ['edit', 'everywhere', 'reset'];

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

function parseLayouts(value: unknown): WidgetLayouts {
  if (!value) return {};
  if (typeof value === 'object') return { ...(value as WidgetLayouts) };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type Stmt = { sql: string; params: unknown[] };

function writeStmts(widgetId: string, dashboardId: string, r: LayoutEditResult, hasLayouts: boolean): Stmt[] {
  const out: Stmt[] = [];
  if (r.grid) {
    out.push({
      sql: 'UPDATE widgets SET grid_x = ?, grid_y = ?, grid_w = ?, grid_h = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?',
      params: [r.grid.x, r.grid.y, r.grid.w, r.grid.h, widgetId, dashboardId],
    });
  }
  if (hasLayouts) {
    out.push({
      sql: 'UPDATE widgets SET layouts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?',
      params: [JSON.stringify(r.layouts), widgetId, dashboardId],
    });
  }
  return out;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = await requirePermission(auth, 'dashboards.edit');
  if (roleError) return roleError;
  const { dashboardId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const { breakpoint: rawBreakpoint, layout, mode: rawMode } = (body ?? {}) as { breakpoint?: unknown; layout?: unknown; mode?: unknown };

  const breakpoint: GridBreakpoint = rawBreakpoint === undefined || rawBreakpoint === null ? 'lg' : (rawBreakpoint as GridBreakpoint);
  if (!isGridBreakpoint(breakpoint)) return badRequest('Unknown breakpoint');
  const mode: LayoutUpdateMode = rawMode === undefined || rawMode === null ? 'edit' : (rawMode as LayoutUpdateMode);
  if (!MODES.includes(mode)) return badRequest('mode must be edit, everywhere or reset');
  const stacked = STACKED_BREAKPOINTS.includes(breakpoint);
  if (mode === 'everywhere' && stacked) return badRequest('A phone layout cannot be used for every screen size');

  let valid: ({ widgetId: string } & GridRect)[] = [];
  if (mode !== 'reset') {
    if (!Array.isArray(layout)) return badRequest('layout must be array');
    if (layout.length > 500) return badRequest('layout too large');
    const items = layout.map(parseItem);
    if (items.some(i => i === null)) return badRequest('Each layout item needs widgetId and non-negative integer x, y, w, h');
    valid = items as ({ widgetId: string } & GridRect)[];
    if (valid.length === 0) return NextResponse.json({ data: { success: true, updated: 0 } });
  }

  try {
    const existing = await rqlite.query('SELECT * FROM widgets WHERE dashboard_id = ?', [dashboardId]);
    const rows = rowsToObjects(existing);
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const foreign = valid.filter(i => !byId.has(i.widgetId)).map(i => i.widgetId);
    if (foreign.length) return badRequest(`Widgets not on this dashboard: ${foreign.join(', ')}`);

    const hasLayouts = rows.length === 0 || 'layouts' in rows[0];
    // Before the widgets.layouts migration only the base (lg) can be written, as it always was.
    if (!hasLayouts && (breakpoint !== 'lg' || mode !== 'edit')) {
      return NextResponse.json(
        { error: { message: 'Per-breakpoint layouts are not available until the widgets.layouts migration has run' } },
        { status: 409 }
      );
    }

    const stmts: Stmt[] = [];
    if (mode === 'reset') {
      for (const r of rows) {
        const current = parseLayouts(r.layouts);
        if (!current[breakpoint]) continue;
        stmts.push(...writeStmts(String(r.id), dashboardId, { layouts: resetLayoutAt(current, breakpoint) }, true));
      }
    } else {
      for (const i of valid) {
        const rect = { x: i.x, y: i.y, w: i.w, h: i.h };
        const result = mode === 'everywhere'
          ? applyLayoutEverywhere(breakpoint, rect)
          : applyLayoutEdit(parseLayouts(byId.get(i.widgetId)?.layouts), breakpoint, rect);
        stmts.push(...writeStmts(i.widgetId, dashboardId, result, hasLayouts));
      }
    }

    if (stmts.length > 0) await rqlite.executeBatch(stmts);
    return NextResponse.json({ data: { success: true, breakpoint, mode, updated: mode === 'reset' ? stmts.length : valid.length } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
