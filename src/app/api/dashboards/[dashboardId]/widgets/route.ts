import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { resolveWidgetDefinition, supportsPlatform } from '@/components/widgets/registry-loader';
import { ensurePollingConfig } from '@/lib/widgets/polling-config';
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
    // Reject a widget type that does not support this server's platform, so a
    // Linux-only custom widget cannot be placed on a Windows server via the API.
    const srvRow = await rqlite.query('SELECT platform FROM servers WHERE id=?', [server_id]);
    const platform = (srvRow.values?.[0]?.[0] as string) || 'linux';
    if (def && !supportsPlatform(def, platform)) {
      return NextResponse.json({ error: { message: `Widget "${widget_type}" is not supported on ${platform}` } }, { status: 400 });
    }
    const wid = crypto.randomUUID();
    let y = grid_y ?? 0;
    if (grid_y===undefined) { const my=await rqlite.query('SELECT COALESCE(MAX(grid_y+grid_h),0) FROM widgets WHERE dashboard_id=?',[dashboardId]); y=(my.values?.[0]?.[0] as number)||0; }
    // Use user-provided grid_w/grid_h if explicitly passed, otherwise use widget definition defaults
    const hasExplicitW = grid_w !== undefined;
    const hasExplicitH = grid_h !== undefined;
    const w = hasExplicitW ? grid_w : (def?.defaultSize?.w ?? 4);
    const h = hasExplicitH ? grid_h : (def?.defaultSize?.h ?? 3);
    await rqlite.execute("INSERT INTO widgets (id,dashboard_id,widget_type,server_id,title_override,config,grid_x,grid_y,grid_w,grid_h,grid_min_w,grid_min_h) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [wid,dashboardId,widget_type,server_id,title_override||null,JSON.stringify(config||{}),grid_x??0,y,w,h,def?.minSize.w??2,def?.minSize.h??2]);
    // Seed the polling config so the background poller caches this widget and
    // dashboards load from the database instead of a live SSH call each time.
    try { await ensurePollingConfig({ id: wid, widget_type, server_id }); } catch (e) { console.error('polling config seed failed:', e); }
    const r = await rqlite.query('SELECT * FROM widgets WHERE id=?', [wid]);
    return NextResponse.json({ data: { widget: rowsToObjects(r)[0] } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}