import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import crypto from 'crypto';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const result = await rqlite.query('SELECT id, name, hostname FROM servers ORDER BY name');
    const servers = rowsToObjects(result).map(s => ({ id: s.id, name: s.name, host: s.hostname }));
    return NextResponse.json({ servers });
  } catch (error) {
    console.error('Servers list error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role !== 'admin') return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
    const { name, hostname, ssh_port, ssh_user, ssh_key_id, notes, tags } = await request.json();
    if (!name || !hostname || !ssh_user) return NextResponse.json({ error: { message: 'name, hostname, ssh_user required' } }, { status: 400 });
    const serverId = crypto.randomUUID();
    const now = new Date().toISOString();
    await rqlite.execute("INSERT INTO servers (id,name,hostname,ssh_port,ssh_user,ssh_key_id,notes,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [serverId, name, hostname, ssh_port||22, ssh_user, ssh_key_id||null, notes||null, JSON.stringify(tags||[]), now, now]);
    await rqlite.execute("INSERT INTO dashboards (id,name,type,server_id,sort_order,created_at,updated_at) VALUES (?,?,'server',?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM dashboards WHERE type='server'),?,?)", [crypto.randomUUID(), name, serverId, now, now]);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_CREATE, status: 'success' });
    return NextResponse.json({ data: { id: serverId, name, hostname } }, { status: 201 });
  } catch (error) {
    console.error('Server create error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}