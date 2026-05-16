import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { sshPool } from '@/lib/ssh/connection-pool';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { serverId } = await params;
    const result = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
    const servers = rowsToObjects(result);
    if (servers.length === 0) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    return NextResponse.json({ data: servers[0] });
  } catch (error) {
    console.error('Server get error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role !== 'admin') return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
    const { serverId } = await params;
    const body = await request.json();
    const allowed = ['name','hostname','ssh_port','ssh_user','ssh_key_id','notes','tags','os_type','os_version','os_codename','kernel_version'];
    const updates: string[] = []; const values: any[] = [];
    for (const [k,v] of Object.entries(body)) { if (allowed.includes(k)) { updates.push(`${k} = ?`); values.push(k==='tags' ? JSON.stringify(v) : v); } }
    if (!updates.length) return NextResponse.json({ error: { message: 'Nothing to update' } }, { status: 400 });
    updates.push('updated_at = CURRENT_TIMESTAMP'); values.push(serverId);
    await rqlite.execute(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, values);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_UPDATE, status: 'success' });
    const result = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
    return NextResponse.json({ data: rowsToObjects(result)[0] });
  } catch (error) {
    console.error('Server update error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role !== 'admin') return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
    const { serverId } = await params;
    await rqlite.execute("DELETE FROM dashboards WHERE type='server' AND server_id=?", [serverId]);
    await rqlite.execute("DELETE FROM servers WHERE id=?", [serverId]);
    try { await sshPool.drainServer(serverId); } catch {}
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_DELETE, status: 'success' });
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('Server delete error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}