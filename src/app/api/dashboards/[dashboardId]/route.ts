import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { dashboardId } = await params;

  try {
    const dashResult = await rqlite.query('SELECT * FROM dashboards WHERE id = ?', [dashboardId]);
    if (dashResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'Dashboard not found' } }, { status: 404 });
    }

    const widgetsResult = await rqlite.query(
      'SELECT w.*, s.name AS server_name, s.hostname AS server_host FROM widgets w LEFT JOIN servers s ON s.id = w.server_id WHERE w.dashboard_id = ? ORDER BY w.grid_y, w.grid_x',
      [dashboardId]
    );

    const dashboard = rowsToObjects(dashResult)[0];
    const widgets = rowsToObjects(widgetsResult).map((w:any) => ({ ...w, config: w.config ? (typeof w.config==='string' ? JSON.parse(w.config||'{}') : w.config) : {} }));

    return NextResponse.json({ data: { dashboard, widgets } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { dashboardId } = await params;
  try {
    const body = await request.json();
    const { name, icon, sort_order } = body;
    const ex = await rqlite.query('SELECT type FROM dashboards WHERE id=?', [dashboardId]);
    if (!ex.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    if (['home','server'].includes(ex.values[0][0] as string) && name) return NextResponse.json({ error: { message: 'Cannot rename' } }, { status: 400 });
    const u: string[]=[]; const v: any[]=[];
    if (name!==undefined) { u.push('name=?'); v.push(name); }
    if (icon!==undefined) { u.push('icon=?'); v.push(icon); }
    if (sort_order!==undefined) { u.push('sort_order=?'); v.push(sort_order); }
    if (!u.length) return NextResponse.json({ error: { message: 'Nothing to update' } }, { status: 400 });
    u.push('updated_at=CURRENT_TIMESTAMP'); v.push(dashboardId);
    await rqlite.execute(`UPDATE dashboards SET ${u.join(',')} WHERE id=?`, v);
    const r = await rqlite.query('SELECT * FROM dashboards WHERE id=?', [dashboardId]);
    return NextResponse.json({ data: { dashboard: rowsToObjects(r)[0] } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { dashboardId } = await params;
  try {
    const existing = await rqlite.query('SELECT type FROM dashboards WHERE id=?', [dashboardId]);
    if (!existing.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    if (['home','server'].includes(existing.values[0][0] as string)) return NextResponse.json({ error: { message: 'Cannot delete home/server dashboards' } }, { status: 400 });
    await rqlite.execute('DELETE FROM dashboards WHERE id=?', [dashboardId]);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}