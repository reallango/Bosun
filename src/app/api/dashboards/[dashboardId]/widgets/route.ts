import { findFreeSpot } from '@/lib/widgets/placement';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { resolveWidgetDefinition, supportsPlatform } from '@/components/widgets/registry-loader';
import crypto from 'crypto';

export async function GET(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
    const auth = await requireAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { dashboardId } = await params;
    try {
        const result = await rqlite.query('SELECT * FROM widgets WHERE dashboard_id = ? ORDER BY grid_y, grid_x', [dashboardId]);
        const widgets = rowsToObjects(result).map((w: any) => ({
            ...w,
            config: typeof w.config === 'string' ? JSON.parse(w.config) : w.config || {},
        }));
        return NextResponse.json({ data: { widgets } });
    } catch (error) {
        console.error('Get dashboard widgets error:', error);
        return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
    }
}


export async function POST(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { dashboardId } = await params;
  try {
    const { widget_type, server_id, config, title_override, grid_x, grid_y, grid_w, grid_h } = await request.json();
    if (!widget_type||!server_id) return NextResponse.json({ error: { message: 'widget_type and server_id required' } }, { status: 400 });
    const def = await resolveWidgetDefinition(widget_type);
    if (!def) return NextResponse.json({ error: { message: `Unknown widget type: ${widget_type}` } }, { status: 400 });
    // Platform support and enabled state are enforced here, not just hidden in the picker.
    const srv = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [server_id]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const platform = (srv.values[0][0] as string) || 'linux';
    if (!supportsPlatform(def, platform)) {
      return NextResponse.json({ error: { message: `${def.displayName} is not available on ${platform} servers` } }, { status: 400 });
    }
    if (def.isCustom) {
      const enabled = await rqlite.query('SELECT enabled FROM custom_widgets WHERE type = ?', [widget_type]);
      if (Number(enabled.values?.[0]?.[0]) !== 1) {
        return NextResponse.json({ error: { message: `${def.displayName} is disabled` } }, { status: 400 });
      }
    }
    // Seed config from the definition's field defaults; explicit values win.
    const initialConfig = {
      ...Object.fromEntries((def.configSchema || []).filter(f => f.default !== undefined).map(f => [f.key, f.default])),
      ...(config && typeof config === 'object' ? config : {}),
    };
    const wid = crypto.randomUUID();
    // Use user-provided grid_w/grid_h if explicitly passed, otherwise use widget definition defaults
    const w = grid_w !== undefined ? grid_w : (def?.defaultSize?.w ?? 4);
    const h = grid_h !== undefined ? grid_h : (def?.defaultSize?.h ?? 3);
    // Without an explicit position, take the first free spot on the lg grid.
    let x = grid_x ?? 0;
    let y = grid_y ?? 0;
    if (grid_x === undefined || grid_y === undefined) {
      const ex = await rqlite.query('SELECT grid_x, grid_y, grid_w, grid_h FROM widgets WHERE dashboard_id=?', [dashboardId]);
      const spot = findFreeSpot(ex.values.map(([gx, gy, gw, gh]) => ({ x: Number(gx), y: Number(gy), w: Number(gw), h: Number(gh) })), w, h);
      x = spot.x;
      y = spot.y;
    }
    await rqlite.execute("INSERT INTO widgets (id,dashboard_id,widget_type,server_id,title_override,config,grid_x,grid_y,grid_w,grid_h,grid_min_w,grid_min_h) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [wid,dashboardId,widget_type,server_id,title_override||null,JSON.stringify(initialConfig),x,y,w,h,def?.minSize.w??2,def?.minSize.h??2]);
    const r = await rqlite.query('SELECT * FROM widgets WHERE id=?', [wid]);
    return NextResponse.json({ data: { widget: rowsToObjects(r)[0] } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}