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

    const widgetsResult = await rqlite.query('SELECT * FROM widgets WHERE dashboard_id = ? ORDER BY grid_y, grid_x', [dashboardId]);

    const dashboard = rowsToObjects(dashResult)[0];
    const widgets = rowsToObjects(widgetsResult);

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

    const existing = await rqlite.query('SELECT type FROM dashboards WHERE id = ?', [dashboardId]);
    if (existing.values.length === 0) {
      return NextResponse.json({ error: { message: 'Dashboard not found' } }, { status: 404 });
    }

    const [type] = existing.values[0];
    if (type !== 'custom' && name) {
      return NextResponse.json({ error: { message: 'Cannot rename home or server dashboards' } }, { status: 400 });
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (name) { updates.push('name = ?'); values.push(name); }
    if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }

    if (updates.length === 0) {
      return NextResponse.json({ error: { message: 'No fields to update' } }, { status: 400 });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(dashboardId);

    await rqlite.execute(`UPDATE dashboards SET ${updates.join(', ')} WHERE id = ?`, values);

    return NextResponse.json({ data: { success: true } });
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
    const existing = await rqlite.query('SELECT type FROM dashboards WHERE id = ?', [dashboardId]);
    if (existing.values.length === 0) {
      return NextResponse.json({ error: { message: 'Dashboard not found' } }, { status: 404 });
    }

    const [type] = existing.values[0];
    if (type !== 'custom') {
      return NextResponse.json({ error: { message: 'Cannot delete home or server dashboards' } }, { status: 400 });
    }

    await rqlite.execute('DELETE FROM widgets WHERE dashboard_id = ?', [dashboardId]);
    await rqlite.execute('DELETE FROM dashboards WHERE id = ?', [dashboardId]);

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}