import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { widgetId } = await params;
  try {
    const { config, title_override, grid_x, grid_y, grid_w, grid_h } = await request.json();
    const u: string[]=[]; const v: any[]=[];
    if (config!==undefined) { u.push('config=?'); v.push(JSON.stringify(config)); }
    if (title_override!==undefined) { u.push('title_override=?'); v.push(title_override); }
    if (grid_x!==undefined) { u.push('grid_x=?'); v.push(grid_x); }
    if (grid_y!==undefined) { u.push('grid_y=?'); v.push(grid_y); }
    if (grid_w!==undefined) { u.push('grid_w=?'); v.push(grid_w); }
    if (grid_h!==undefined) { u.push('grid_h=?'); v.push(grid_h); }
    if (!u.length) return NextResponse.json({ error: { message: 'Nothing to update' } }, { status: 400 });
    u.push('updated_at=CURRENT_TIMESTAMP'); v.push(widgetId);
    await rqlite.execute(`UPDATE widgets SET ${u.join(',')} WHERE id=?`, v);
    const r = await rqlite.query('SELECT * FROM widgets WHERE id=?', [widgetId]);
    return NextResponse.json({ data: { widget: rowsToObjects(r)[0] } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { widgetId } = await params;
  try {
    await rqlite.execute('DELETE FROM widgets WHERE id=?', [widgetId]);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}