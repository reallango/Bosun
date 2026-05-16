import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getWidgetDefinition } from '@/components/widgets/registry';
import crypto from 'crypto';

export async function POST(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { dashboardId } = await params;
  try {
    const { widget_type, server_id, config, title_override, grid_x, grid_y, grid_w, grid_h } = await request.json();
    if (!widget_type||!server_id) return NextResponse.json({ error: { message: 'widget_type and server_id required' } }, { status: 400 });
    const def = getWidgetDefinition(widget_type);
    const wid = crypto.randomUUID();
    let y = grid_y ?? 0;
    if (grid_y===undefined) { const my=await rqlite.query('SELECT COALESCE(MAX(grid_y+grid_h),0) FROM widgets WHERE dashboard_id=?',[dashboardId]); y=(my.values?.[0]?.[0] as number)||0; }
    const w=grid_w??def?.defaultSize.w??4, h=grid_h??def?.defaultSize.h??3;
    await rqlite.execute("INSERT INTO widgets (id,dashboard_id,widget_type,server_id,title_override,config,grid_x,grid_y,grid_w,grid_h,grid_min_w,grid_min_h) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [wid,dashboardId,widget_type,server_id,title_override||null,JSON.stringify(config||{}),grid_x??0,y,w,h,def?.minSize.w??2,def?.minSize.h??2]);
    const r = await rqlite.query('SELECT * FROM widgets WHERE id=?', [wid]);
    return NextResponse.json({ data: { widget: rowsToObjects(r)[0] } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}