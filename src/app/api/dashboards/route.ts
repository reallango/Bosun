import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import crypto from 'crypto';
import { DASHBOARD_NAME_MAX } from '@/lib/dashboards/events';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const url = new URL(request.url);
    const typeFilter = url.searchParams.get('type');
    let sql = 'SELECT * FROM dashboards ORDER BY type, sort_order';
    let params: any[] = [];
    if (typeFilter) { sql = 'SELECT * FROM dashboards WHERE type = ? ORDER BY sort_order'; params = [typeFilter]; }
    const result = await rqlite.query(sql, params);
    const dashboards = rowsToObjects(result);
    return NextResponse.json({ data: { dashboards } });
  } catch (error) {
    return NextResponse.json({ data: { dashboards: [] }, error: { message: String(error) } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'operator');
  if (roleError) return roleError;
  try {
    const body = await request.json();
    const { icon } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: { message: 'Name required' } }, { status: 400 });
    if (name.length > DASHBOARD_NAME_MAX) return NextResponse.json({ error: { message: `Name must be at most ${DASHBOARD_NAME_MAX} characters` } }, { status: 400 });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await rqlite.execute(
      "INSERT INTO dashboards (id, name, type, sort_order, icon, created_at, updated_at) VALUES (?, ?, 'custom', (SELECT COALESCE(MAX(sort_order),0)+1 FROM dashboards WHERE type='custom'), ?, ?, ?)",
      [id, name, icon || null, now, now]
    );
    return NextResponse.json({ data: { dashboard: { id, name, type: 'custom', icon: icon||null, created_at: now } } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

/** Reorder the custom dashboards: body { order: [id, ...] }, first id shown first. */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'operator');
  if (roleError) return roleError;
  try {
    const { order } = await request.json();
    if (!Array.isArray(order) || order.length === 0 || !order.every(id => typeof id === 'string') || new Set(order).size !== order.length) {
      return NextResponse.json({ error: { message: 'order must be a list of unique dashboard ids' } }, { status: 400 });
    }
    const existing = await rqlite.query("SELECT id FROM dashboards WHERE type = 'custom'");
    const known = new Set(existing.values.map(r => String(r[0])));
    if (order.some(id => !known.has(id))) {
      return NextResponse.json({ error: { message: 'Unknown dashboard in order' } }, { status: 400 });
    }
    await rqlite.executeBatch(
      order.map((id, i) => ({ sql: "UPDATE dashboards SET sort_order = ? WHERE id = ? AND type = 'custom'", params: [i + 1, id] })),
      { transaction: true }
    );
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
