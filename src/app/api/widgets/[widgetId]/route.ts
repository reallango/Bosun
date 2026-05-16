import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;

  const { widgetId } = await params;

  try {
    const body = await request.json();
    const { config, title_override, grid_x, grid_y, grid_w, grid_h } = body;

    const updates: string[] = [];
    const values: any[] = [];

    if (config) { updates.push('config = ?'); values.push(JSON.stringify(config)); }
    if (title_override !== undefined) { updates.push('title_override = ?'); values.push(title_override); }
    if (grid_x !== undefined) { updates.push('grid_x = ?'); values.push(grid_x); }
    if (grid_y !== undefined) { updates.push('grid_y = ?'); values.push(grid_y); }
    if (grid_w !== undefined) { updates.push('grid_w = ?'); values.push(grid_w); }
    if (grid_h !== undefined) { updates.push('grid_h = ?'); values.push(grid_h); }

    if (updates.length === 0) {
      return NextResponse.json({ error: { message: 'No fields to update' } }, { status: 400 });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(widgetId);

    await rqlite.execute(`UPDATE widgets SET ${updates.join(', ')} WHERE id = ?`, values);

    return NextResponse.json({ data: { success: true } });
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
    await rqlite.execute('DELETE FROM widgets WHERE id = ?', [widgetId]);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}