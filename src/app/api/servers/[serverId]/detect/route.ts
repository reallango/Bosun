import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { serverId } = await params;
    const srv = await rqlite.query('SELECT * FROM servers WHERE id=?', [serverId]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    const s = rowsToObjects(srv)[0] as any;
    if (!s.ssh_key_id) return NextResponse.json({ error: { message: 'No SSH key' } }, { status: 400 });
    const keyR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [s.ssh_key_id]);
    if (!keyR.values?.length) return NextResponse.json({ error: { message: 'Key not found' } }, { status: 404 });
    const pk = decrypt(keyR.values[0][0] as string, process.env.MASTER_KEY || '');
    const cfg: SSHConnectionConfig = { host: s.hostname, port: s.ssh_port||22, username: s.ssh_user, privateKey: pk };
    const run = async (cmd: string) => sshPool.executeCommand(serverId, cfg, cmd);

    const unraid = await run('cat /etc/unraid-version 2>/dev/null');
    let osType='generic', osVer='', osCn='';
    if (unraid.exitCode===0 && unraid.stdout.trim()) {
        osType='unraid'; osVer=unraid.stdout.match(/version="?([^"\n]+)"?/)?.[1]||'';
    } else {
        const osr = await run('cat /etc/os-release');
        const p: Record<string,string> = {};
        osr.stdout.split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) p[k.trim()]=v.join('=').replace(/"/g,'').trim(); });
        const id=(p['ID']||'').toLowerCase();
        osType=['ubuntu','pop','linuxmint'].includes(id)?'ubuntu':['debian','raspbian'].includes(id)?'debian':id||'generic';
        osVer=p['VERSION_ID']||''; osCn=p['VERSION_CODENAME']||'';
    }
    const [kern,cpu,mem] = await Promise.all([run('uname -r'), run('lscpu 2>/dev/null||cat /proc/cpuinfo|head -20'), run('cat /proc/meminfo')]);
    let cpuModel='Unknown', cores=1;
    cpu.stdout.split('\n').forEach(l => { if(l.startsWith('Model name:')) cpuModel=l.split(':')[1]?.trim()||cpuModel; if(l.startsWith('CPU(s):')) cores=parseInt(l.split(':')[1]?.trim()||'1',10); });
    const mm = mem.stdout.match(/MemTotal:\s+(\d+)/);
    const ram = mm ? Math.round(parseInt(mm[1],10)/1024) : 0;
    await rqlite.execute("UPDATE servers SET os_type=?,os_version=?,os_codename=?,kernel_version=?,cpu_model=?,cpu_cores=?,total_ram_mb=?,is_online=1,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [osType,osVer,osCn,kern.stdout.trim(),cpuModel,cores,ram,serverId]);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_DETECT, status: 'success', details: `${osType} ${osVer}` });
    return NextResponse.json({ data: { os_type:osType, os_version:osVer, os_codename:osCn, kernel_version:kern.stdout.trim(), cpu_model:cpuModel, cpu_cores:cores, total_ram_mb:ram } });
  } catch (error) {
    console.error('OS detect error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}