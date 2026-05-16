import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth } from '@/lib/auth/middleware';
import crypto from 'crypto';

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
  try {
    const body = await request.json();
    const { name, icon } = body;
    if (!name) return NextResponse.json({ error: { message: 'Name required' } }, { status: 400 });
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