import { internalError } from '@/lib/api/response';
import { formatMac } from '@/lib/network/wake-on-lan';
import { NextRequest, NextResponse } from 'next/server';
import { requireLevel } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { SHELL_ACCOUNT_RE } from '@/lib/ssh/shell-account';
import crypto from 'crypto';

export async function GET(request: NextRequest) {
  try {
    const payload = await requireLevel(request, 'viewer');
    if (payload instanceof NextResponse) return payload;
    const result = await rqlite.query('SELECT id, name, hostname, ssh_port, ssh_user, ssh_key_id, shell_user, shell_key_id, platform, os_type, os_version, cpu_model, cpu_cores, total_ram_mb, is_online, last_seen, last_error, poll_enabled, poll_interval_sec, capabilities, mac_address, mac_address_alt FROM servers ORDER BY name');
    const servers = rowsToObjects(result).map(s => ({ 
      id: s.id, 
      name: s.name, 
      host: s.hostname,
      ssh_port: s.ssh_port,
      ssh_user: s.ssh_user,
      ssh_key_id: s.ssh_key_id,
      shell_user: s.shell_user ?? null,
      shell_enabled: Boolean(s.shell_user && s.shell_key_id),
      os_type: s.os_type,
      os_version: s.os_version,
      platform: s.platform || 'linux',
      cpu_model: s.cpu_model,
      cpu_cores: s.cpu_cores,
      total_ram_mb: s.total_ram_mb,
      is_online: Boolean(s.is_online),
      last_seen: s.last_seen,
      last_error: s.last_error,
      mac_address: s.mac_address ?? null,
      mac_address_alt: s.mac_address_alt ?? null,
      poll_enabled: Boolean(s.poll_enabled),
      poll_interval_sec: s.poll_interval_sec,
      capabilities: (() => { try { return JSON.parse(String(s.capabilities || '{}')); } catch { return {}; } })(),
    }));
    return NextResponse.json({ data: { servers } });
  } catch (error) {
    console.error('Servers list error:', error);
    return internalError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = await requireLevel(request, 'admin');
    if (payload instanceof NextResponse) return payload;
    const { name, hostname, ssh_port, ssh_user, ssh_key_id, shell_user, shell_key_id, notes, tags, platform, mac_address, mac_address_alt } = await request.json();
    // Unset MACs stay NULL so the poller fills them from the host's NICs.
    let mac: string | null = null;
    let macAlt: string | null = null;
    if (mac_address_alt) {
      macAlt = formatMac(String(mac_address_alt));
      if (!macAlt) return NextResponse.json({ error: { message: 'Invalid alternate MAC address' } }, { status: 400 });
    }
    if (mac_address) {
      mac = formatMac(String(mac_address));
      if (!mac) return NextResponse.json({ error: { message: 'Invalid MAC address' } }, { status: 400 });
    }
    if (!name || !hostname || !ssh_user) return NextResponse.json({ error: { message: 'name, hostname, ssh_user required' } }, { status: 400 });
    if ((shell_user || shell_key_id) && !(typeof shell_user === 'string' && SHELL_ACCOUNT_RE.test(shell_user) && typeof shell_key_id === 'string' && shell_user !== ssh_user && shell_key_id !== ssh_key_id)) {
      return NextResponse.json({ error: { message: 'shell_user and shell_key_id must be given together, shell_user must be a valid account name different from ssh_user, and the key must differ from ssh_key_id' } }, { status: 400 });
    }
    const serverId = crypto.randomUUID();
    const now = new Date().toISOString();
    const platformValue = platform === 'windows' ? 'windows' : 'linux';
    // Windows runs PowerShell per poll, which costs more than a sh script; poll it less often.
    const configured = Number((await rqlite.query("SELECT value FROM app_config WHERE key = 'poller.default_interval_sec'")).values?.[0]?.[0]) || 15;
    const pollInterval = platformValue === 'windows' ? Math.max(30, configured) : configured;
    await rqlite.execute("INSERT INTO servers (id,name,hostname,ssh_port,ssh_user,ssh_key_id,shell_user,shell_key_id,notes,tags,platform,poll_interval_sec,mac_address,mac_address_alt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [serverId, name, hostname, ssh_port||22, ssh_user, ssh_key_id||null, shell_user||null, shell_key_id||null, notes||null, JSON.stringify(tags||[]), platformValue, pollInterval, mac, macAlt, now, now]);
    await rqlite.execute("INSERT INTO dashboards (id,name,type,server_id,sort_order,created_at,updated_at) VALUES (?,?,'server',?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM dashboards WHERE type='server'),?,?)", [crypto.randomUUID(), name, serverId, now, now]);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_CREATE, status: 'success' });
    return NextResponse.json({ data: { id: serverId, name, hostname } }, { status: 201 });
  } catch (error) {
    console.error('Server create error:', error);
    return internalError(error);
  }
}