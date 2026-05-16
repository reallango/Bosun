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
    const { layout } = await request.json();
    if (!Array.isArray(layout)) return NextResponse.json({ error: { message: 'layout must be array' } }, { status: 400 });
    const stmts = layout.map((i:any) => ({ sql: 'UPDATE widgets SET grid_x=?,grid_y=?,grid_w=?,grid_h=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND dashboard_id=?', params: [i.x,i.y,i.w,i.h,i.widgetId,dashboardId] }));
    if (stmts.length) await rqlite.executeBatch(stmts);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}