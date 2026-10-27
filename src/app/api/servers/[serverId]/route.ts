import { formatMac } from '@/lib/network/wake-on-lan';
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
    const allowed = ['name','hostname','ssh_port','ssh_user','ssh_key_id','notes','tags','platform','os_type','os_version','os_codename','kernel_version',
      'poll_enabled','poll_interval_sec','host_key_fingerprint','mac_address'];
    const updates: string[] = []; const values: any[] = [];
    for (const [k,v] of Object.entries(body)) {
      if (!allowed.includes(k)) continue;
      let value: unknown = v;
      if (k === 'tags') value = JSON.stringify(v);
      if (k === 'platform') value = v === 'windows' ? 'windows' : 'linux';
      if (k === 'poll_enabled') value = v ? 1 : 0;
      if (k === 'poll_interval_sec') value = Math.min(3600, Math.max(5, Math.round(Number(v) || 15)));
      // Only clearing is allowed (re-trust a host whose key legitimately changed).
      if (k === 'host_key_fingerprint') { if (v !== null) continue; value = null; }
      if (k === 'mac_address' && v) {
        value = formatMac(String(v));
        if (!value) return NextResponse.json({ error: { message: 'Invalid MAC address' } }, { status: 400 });
      } else if (k === 'mac_address') value = null;
      updates.push(`${k} = ?`); values.push(value);
    }
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
    // Remove everything that hangs off the server in one transaction (does not
    // rely on SQLite foreign-key enforcement being enabled).
    await rqlite.executeBatch([
      "DELETE FROM widgets WHERE server_id=? OR dashboard_id IN (SELECT id FROM dashboards WHERE type='server' AND server_id=?)",
      "DELETE FROM dashboards WHERE type='server' AND server_id=?",
      'DELETE FROM host_snapshots WHERE server_id=?',
      'DELETE FROM metric_samples WHERE server_id=?',
      'DELETE FROM metric_rollups WHERE server_id=?',
      'DELETE FROM alert_rules WHERE server_id=?',
      'DELETE FROM notifications WHERE server_id=?',
      'DELETE FROM servers WHERE id=?',
    ].map(sql => ({ sql, params: sql.split('?').length === 3 ? [serverId, serverId] : [serverId] })), { transaction: true });
    try { await sshPool.drainServer(serverId); } catch {}
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_DELETE, status: 'success' });
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('Server delete error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}