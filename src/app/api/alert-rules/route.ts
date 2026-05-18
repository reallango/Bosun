import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const user = auth as any;

  try {
    const { searchParams } = new URL(request.url);
    const enabledOnly = searchParams.get('enabled') === 'true';
    
    let query = 'SELECT * FROM alert_rules WHERE 1=1';
    const params: any[] = [];
    
    if (enabledOnly) {
      query += ' AND enabled = 1';
    }
    
    query += ' ORDER BY name';
    
    const result = await rqlite.query(query, params);
    const rules = rowsToObjects(result).map((r: any) => ({
      ...r,
      channels: r.channels ? JSON.parse(r.channels) : [],
      channel_config: r.channel_config ? JSON.parse(r.channel_config) : {}
    }));

    return NextResponse.json({ data: { rules } });
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
    const { name, description, server_id, metric, condition, severity, channels, cooldown_sec, enabled } = body;
    
    if (!name || !metric || !condition) {
      return NextResponse.json({ error: { message: 'Name, metric, and condition required' } }, { status: 400 });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    
    await rqlite.execute(
      `INSERT INTO alert_rules (id, name, description, server_id, metric, condition, severity, channels, channel_config, cooldown_sec, enabled, trigger_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 0, ?, ?)`,
      [id, name, description || null, server_id || null, metric, condition, severity || 'warning', JSON.stringify(channels || []), cooldown_sec || 300, enabled !== false ? 1 : 0, now, now]
    );

    return NextResponse.json({ data: { id, message: 'Alert rule created' } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'admin');
  if (roleError) return roleError;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json({ error: { message: 'ID required' } }, { status: 400 });
    }

    await rqlite.execute('DELETE FROM alert_rules WHERE id = ?', [id]);

    return NextResponse.json({ data: { message: 'Deleted' } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}