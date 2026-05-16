import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;

  const { dashboardId } = await params;

  try {
    const body = await request.json();
    const { layout } = body;

    if (!layout || !Array.isArray(layout)) {
      return NextResponse.json({ error: { message: 'Layout array required' } }, { status: 400 });
    }

    for (const item of layout) {
      const { widgetId, x, y, w, h } = item;
      if (!widgetId) continue;

      await rqlite.execute(
        'UPDATE widgets SET grid_x = ?, grid_y = ?, grid_w = ?, grid_h = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?',
        [x, y, w, h, widgetId, dashboardId]
      );
    }

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}