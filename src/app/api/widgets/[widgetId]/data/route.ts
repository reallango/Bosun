import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth } from '@/lib/auth/middleware';
import { SSHConnectionPool } from '@/lib/ssh/connection-pool';
import { AdapterFactory } from '@/lib/ssh/adapters/factory';

const pool = new SSHConnectionPool();

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
    const auth = await requireAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { widgetId } = await params;
  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const widget = rowsToObjects(widgetRes)[0] as any;
    const wCfg = widget.config ? (typeof widget.config==='string'?JSON.parse(widget.config||'{}'):widget.config) : {};
    const srvR = await rqlite.query('SELECT * FROM servers WHERE id=?', [widget.server_id]);
    if (!srvR.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const srv = rowsToObjects(srvR)[0] as any;

    if (widget.widget_type === 'server_summary') {
      return NextResponse.json({ data: { is_online: !!srv.is_online, hostname: srv.hostname, os_type: srv.os_type, os_version: srv.os_version, name: srv.name } });
    }

    if (!srv.ssh_key_id) return NextResponse.json({ error: { message: 'No SSH key' } }, { status: 400 });
    const kR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [srv.ssh_key_id]);
    if (!kR.values?.length) return NextResponse.json({ error: { message: 'Key not found' } }, { status: 404 });
    const { decrypt } = await import('@/lib/crypto/keys');
    const pk = decrypt(kR.values[0][0] as string, process.env.MASTER_KEY||'');
    const sshCfg = { host: srv.hostname, port: srv.ssh_port||22, username: srv.ssh_user, privateKey: pk };
    const run = async (cmd: string) => pool.executeCommand(srv.id, sshCfg, cmd);
    let data: any;

    switch (widget.widget_type) {
        case 'os_info': {
            const [osr,kern,arch,hn,up] = await Promise.all([run('cat /etc/os-release'),run('uname -r'),run('uname -m'),run('hostname'),run('cat /proc/uptime')]);
            const p: Record<string,string> = {};
            osr.stdout.split('\n').forEach(l => { const [k,...v]=l.split('='); if(k&&v.length) p[k.trim()]=v.join('=').replace(/"/g,'').trim(); });
            const sec = parseFloat(up.stdout.split(' ')[0]||'0');
            data = { name: p['NAME']||'Linux', version: p['VERSION_ID']||'', codename: p['VERSION_CODENAME']||'', prettyName: p['PRETTY_NAME']||'Linux', kernel: kern.stdout.trim(), architecture: arch.stdout.trim(), hostname: hn.stdout.trim(), uptime: `${Math.floor(sec/86400)}d ${Math.floor((sec%86400)/3600)}h ${Math.floor((sec%3600)/60)}m`, uptimeSeconds: sec };
            break;
        }
        case 'cpu_memory': {
            const [lscpu,meminfo,loadavg,temp] = await Promise.all([run('lscpu 2>/dev/null||echo none'),run('cat /proc/meminfo'),run('cat /proc/loadavg'),run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null||echo 0')]);
            let cpuModel='Unknown',cores=1,threads=1;
            lscpu.stdout.split('\n').forEach(l => { if(l.startsWith('Model name:')) cpuModel=l.split(':')[1]?.trim()||cpuModel; if(l.startsWith('CPU(s):')) cores=parseInt(l.split(':')[1]?.trim()||'1',10); if(l.startsWith('Thread(s) per core:')) threads=parseInt(l.split(':')[1]?.trim()||'1',10)*cores; });
            const s1=await run("head -1 /proc/stat"); await new Promise(r=>setTimeout(r,500)); const s2=await run("head -1 /proc/stat");
            const ps=(s:string)=>s.trim().split(/\s+/).slice(1).map(Number);
            const a=ps(s1.stdout), b=ps(s2.stdout);
            const td=b.reduce((a,b)=>a+b,0)-a.reduce((a,b)=>a+b,0);
            const id2=(b[3]+(b[4]||0))-(a[3]+(a[4]||0));
            const cpuPct=td>0?((td-id2)/td)*100:0;
            const ml: Record<string,number>={};
            meminfo.stdout.split('\n').forEach(l=>{ const m=l.match(/^(\w+):\s+(\d+)/); if(m) ml[m[1]]=parseInt(m[2],10); });
            const tMB=Math.round((ml['MemTotal']||0)/1024), aMB=Math.round((ml['MemAvailable']||ml['MemFree']||0)/1024), uMB=tMB-aMB;
            const [l1,l5,l15]=loadavg.stdout.trim().split(/\s+/).map(Number);
            const t=parseInt(temp.stdout.trim(),10)/1000;
            data = { cpu: { model:cpuModel,cores,threads,usagePercent:Math.round(cpuPct*10)/10,loadAvg1:l1,loadAvg5:l5,loadAvg15:l15,temperature:t>0?t:null }, memory: { totalMB:tMB,usedMB:uMB,freeMB:tMB-uMB,availableMB:aMB,usagePercent:tMB>0?Math.round((uMB/tMB)*1000)/10:0,swapTotalMB:Math.round((ml['SwapTotal']||0)/1024),swapUsedMB:Math.round(((ml['SwapTotal']||0)-(ml['SwapFree']||0))/1024) } };
            break;
        }
        case 'disk_usage': {
            const df=await run("df -T --block-size=1M --output=source,fstype,size,used,avail,pcent,target 2>/dev/null|tail -n +2");
            data=df.stdout.trim().split('\n').filter(Boolean).map(l=>{const p=l.trim().split(/\s+/);return{filesystem:p[0],fsType:p[1],sizeMB:+p[2],usedMB:+p[3],availableMB:+p[4],usagePercent:parseInt((p[5]||'0').replace('%',''),10),mountPoint:p.slice(6).join(' ')};}).filter(d=>!['tmpfs','devtmpfs','squashfs','overlay'].includes(d.fsType)&&!d.mountPoint.startsWith('/snap'));
            break;
        }
        case 'network': {
            const ip=await run("ip -j addr show 2>/dev/null");
            if(ip.exitCode===0&&ip.stdout.trim().startsWith('[')) {
                data=JSON.parse(ip.stdout).filter((i:any)=>i.ifname!=='lo').map((i:any)=>({name:i.ifname,state:i.operstate||'UNKNOWN',mtu:i.mtu,macAddress:i.address||'',ipv4:(i.addr_info||[]).filter((a:any)=>a.family==='inet').map((a:any)=>a.local),ipv6:(i.addr_info||[]).filter((a:any)=>a.family==='inet6').map((a:any)=>a.local)}));
            } else { data=[]; }
            break;
        }
        case 'system_services': {
            const f=wCfg.filter||'running';
            const cmd=f==='running'?"systemctl list-units --type=service --state=running --no-pager --plain --no-legend":"systemctl list-units --type=service --no-pager --plain --no-legend";
            const r=await run(cmd);
            data=r.stdout.trim().split('\n').filter(Boolean).map(l=>{const p=l.trim().split(/\s+/);return{name:(p[0]||'').replace('.service',''),status:p[2]==='running'?'running':p[2]==='failed'?'failed':'stopped',description:p.slice(4).join(' '),enabled:p[1]==='loaded'};});
            break;
        }
        case 'gpu_monitoring': {
            const r=await run("nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader 2>/dev/null");
            if(r.exitCode===0&&r.stdout.trim()) {
                const line=r.stdout.trim();
                const parts=line.split(',').map(p=>p.trim());
                data={ name:parts[0], vram_total_mb:parseInt(parts[1]||'0',10), vram_used_mb:parseInt(parts[2]||'0',10), utilization_percent:parseInt(parts[3]||'0',10), temperature_c:parseInt(parts[4]||'0',10), power_watts:parseFloat(parts[5]||'0') };
            } else {
                data={ name:'No GPU', vram_total_mb:0, vram_used_mb:0, utilization_percent:0, temperature_c:0, power_watts:0 };
            }
            break;
        }
        case 'ollama_status': {
            // Check if ollama is running
            const check=await run("curl -s http://localhost:11434/api/tags 2>/dev/null");
            if(check.exitCode!==0) {
                data={ status:'stopped', models:[] };
                break;
            }
            try {
                const tags=JSON.parse(check.stdout);
                data={ status:'running', models:tags.models||[] };
            } catch {
                data={ status:'error', models:[] };
            }
            // Check for active pulls
            const pgrep=await run("pgrep -a 'ollama pull' 2>/dev/null || true");
            if(pgrep.exitCode===0&&pgrep.stdout.trim()) {
                data={ ...data as object, pulling:{ name:'unknown', progress:0 } };
            }
            break;
        }
        default: return NextResponse.json({ error: { message: `Unknown type: ${widget.widget_type}` } }, { status: 400 });
    }
    return NextResponse.json({ data });
  } catch (error) {
    console.error('Widget data error:', error);
    // Return placeholder data instead of 500 error so dashboard loads
    return NextResponse.json({ data: { source: 'placeholder', error: String(error).substring(0, 100) } });
  }
}