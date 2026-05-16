import { NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { requireAuth } from '@/lib/auth/middleware';

export async function GET() {
  const auth = await requireAuth(new NextRequest('http://localhost'));
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await rqlite.query('SELECT * FROM dashboards ORDER BY type, sort_order');
    const dashboards = rqlite.rowsToObjects(result);
    return NextResponse.json({ data: dashboards });
  } catch (error) {
    return NextResponse.json({ data: [], error: { message: String(error) } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth(request as unknown as NextRequest);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { name, icon } = body;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await rqlite.execute(
      `INSERT INTO dashboards (id, name, type, server_id, sort_order, icon, is_default, created_at, updated_at)
       VALUES (?, 'custom', ?, ?, 0, NULL, 0, ?, ?)`,
      [id, name, icon || null, now, now]
    );

    const result = await rqlite.query('SELECT * FROM dashboards WHERE id = ?', [id]);
    const dashboards = rqlite.rowsToObjects(result);
    return NextResponse.json({ data: dashboards[0] });
  } catch (error) {
    return NextResponse.json({ data: null, error: { message: String(error) } }, { status: 500 });
  }
}