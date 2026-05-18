import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await rqlite.query('SELECT * FROM notification_channels ORDER BY name');
    const channels = rowsToObjects(result).map((c: any) => ({
      ...c,
      config: c.config ? JSON.parse(c.config) : {}
    }));

    return NextResponse.json({ data: { channels } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'admin');
  if (roleError) return roleError;

  try {
    const body = await request.json();
    const { name, type, config, enabled } = body;
    
    if (!name || !type) {
      return NextResponse.json({ error: { message: 'Name and type required' } }, { status: 400 });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    
    await rqlite.execute(
      `INSERT INTO notification_channels (id, name, type, config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, type, JSON.stringify(config || {}), enabled !== false ? 1 : 0, now, now]
    );

    return NextResponse.json({ data: { id, message: 'Channel created' } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}