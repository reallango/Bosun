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
    const result = await rqlite.query('SELECT id, name, hostname, ssh_port, ssh_user, ssh_key_id, platform, os_type, os_version, cpu_model, cpu_cores, total_ram_mb, is_online, last_seen, last_error, poll_enabled, poll_interval_sec, capabilities FROM servers ORDER BY name');
    const servers = rowsToObjects(result).map(s => ({ 
      id: s.id, 
      name: s.name, 
      host: s.hostname,
      ssh_port: s.ssh_port,
      ssh_user: s.ssh_user,
      ssh_key_id: s.ssh_key_id,
      os_type: s.os_type,
      os_version: s.os_version,
      platform: s.platform || 'linux',
      cpu_model: s.cpu_model,
      cpu_cores: s.cpu_cores,
      total_ram_mb: s.total_ram_mb,
      is_online: Boolean(s.is_online),
      last_seen: s.last_seen,
      last_error: s.last_error,
      poll_enabled: Boolean(s.poll_enabled),
      poll_interval_sec: s.poll_interval_sec,
      capabilities: (() => { try { return JSON.parse(String(s.capabilities || '{}')); } catch { return {}; } })(),
    }));
    return NextResponse.json({ data: { servers } });
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
    const { name, hostname, ssh_port, ssh_user, ssh_key_id, notes, tags, platform } = await request.json();
    if (!name || !hostname || !ssh_user) return NextResponse.json({ error: { message: 'name, hostname, ssh_user required' } }, { status: 400 });
    const serverId = crypto.randomUUID();
    const now = new Date().toISOString();
    const platformValue = platform === 'windows' ? 'windows' : 'linux';
    // Windows runs PowerShell per poll, which costs more than a sh script; poll it less often.
    const configured = Number((await rqlite.query("SELECT value FROM app_config WHERE key = 'poller.default_interval_sec'")).values?.[0]?.[0]) || 15;
    const pollInterval = platformValue === 'windows' ? Math.max(30, configured) : configured;
    await rqlite.execute("INSERT INTO servers (id,name,hostname,ssh_port,ssh_user,ssh_key_id,notes,tags,platform,poll_interval_sec,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [serverId, name, hostname, ssh_port||22, ssh_user, ssh_key_id||null, notes||null, JSON.stringify(tags||[]), platformValue, pollInterval, now, now]);
    await rqlite.execute("INSERT INTO dashboards (id,name,type,server_id,sort_order,created_at,updated_at) VALUES (?,?,'server',?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM dashboards WHERE type='server'),?,?)", [crypto.randomUUID(), name, serverId, now, now]);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_CREATE, status: 'success' });
    return NextResponse.json({ data: { id: serverId, name, hostname } }, { status: 201 });
  } catch (error) {
    console.error('Server create error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}