import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload) {
      return NextResponse.json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } }, { status: 401 });
    }

    const result = await rqlite.query(`
      SELECT s.id, s.name, s.hostname, s.ssh_port, s.ssh_user, s.ssh_key_id, s.os_type, s.os_version, 
             s.os_codename, s.kernel_version, s.notes, s.is_online, s.last_seen, s.cpu_model, s.cpu_cores, 
             s.total_ram_mb, s.tags, s.created_at, s.updated_at,
             k.name as ssh_key_name
      FROM servers s
      LEFT JOIN ssh_keys k ON s.ssh_key_id = k.id
      ORDER BY s.name
    `);

    const servers = result.values.map(row => ({
      id: row[0],
      name: row[1],
      hostname: row[2],
      ssh_port: row[3],
      ssh_user: row[4],
      ssh_key_id: row[5],
      os_type: row[6],
      os_version: row[7],
      os_codename: row[8],
      kernel_version: row[9],
      notes: row[10],
      is_online: !!row[11],
      last_seen: row[12],
      cpu_model: row[13],
      cpu_cores: row[14],
      total_ram_mb: row[15],
      tags: row[16] ? JSON.parse(row[16] as string) : [],
      created_at: row[17],
      updated_at: row[18],
      ssh_key_name: row[19]
    }));

    return NextResponse.json({ data: servers });
  } catch (error) {
    console.error('Servers list error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });
    }

    const { name, hostname, ssh_port, ssh_user, ssh_key_id, notes, tags } = await request.json();

    if (!name || !hostname || !ssh_user) {
      return NextResponse.json({ error: { message: 'Name, hostname, and ssh_user are required', code: 'INVALID_INPUT' } }, { status: 400 });
    }

    // Check for duplicate name
    const existing = await rqlite.query(`SELECT id FROM servers WHERE name = '${name.replace(/'/g, "''")}'`);
    if (existing.values.length > 0) {
      return NextResponse.json({ error: { message: 'Server with this name already exists', code: 'DUPLICATE_NAME' } }, { status: 400 });
    }

    const result = await rqlite.execute(
      `INSERT INTO servers (name, hostname, ssh_port, ssh_user, ssh_key_id, notes, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, hostname, ssh_port || 22, ssh_user, ssh_key_id || null, notes || null, JSON.stringify(tags || [])]
    );

    const serverId = result.last_insert_id;

    // Auto-create server dashboard
    await rqlite.execute(
      `INSERT INTO dashboards (id, name, type, server_id, sort_order, is_default) VALUES (?, ?, 'server', ?, ?, 0)`,
      [serverId, `${name} Dashboard`, serverId]
    );

    return NextResponse.json({ data: { id: serverId, name, hostname } }, { status: 201 });
  } catch (error) {
    console.error('Server create error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}