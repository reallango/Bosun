import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { getWidgetDefinition } from '@/components/widgets/registry';
import crypto from 'crypto';

export async function POST(request: NextRequest, { params }: { params: Promise<{ dashboardId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;

  const { dashboardId } = await params;

  try {
    const body = await request.json();
    const { widget_type, server_id, config, title_override, grid_x, grid_y, grid_w, grid_h } = body;

    if (!widget_type || !server_id) {
      return NextResponse.json({ error: { message: 'widget_type and server_id required' } }, { status: 400 });
    }

    const dashResult = await rqlite.query('SELECT server_id, type FROM dashboards WHERE id = ?', [dashboardId]);
    if (dashResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'Dashboard not found' } }, { status: 404 });
    }

    const [dashboardServerId, dashboardType] = dashResult.values[0];
    if (dashboardType === 'server' && dashboardServerId !== server_id) {
      return NextResponse.json({ error: { message: 'Server mismatch for this dashboard' } }, { status: 400 });
    }

    const def = getWidgetDefinition(widget_type);
    if (!def) {
      return NextResponse.json({ error: { message: 'Unknown widget type' } }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const x = grid_x ?? 0;
    const y = grid_y ?? 0;
    const w = grid_w ?? def.defaultSize.w;
    const h = grid_h ?? def.defaultSize.h;

    await rqlite.execute(
      `INSERT INTO widgets (id, dashboard_id, widget_type, server_id, title_override, config, grid_x, grid_y, grid_w, grid_h, grid_min_w, grid_min_h, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, dashboardId, widget_type, server_id, title_override || null, JSON.stringify(config || {}), x, y, w, h, def.minSize.w, def.minSize.h, now, now]
    );

    return NextResponse.json({ data: { id } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}