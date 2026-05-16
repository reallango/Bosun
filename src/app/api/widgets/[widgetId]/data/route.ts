import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { SSHConnectionPool } from '@/lib/ssh/connection-pool';
import { AdapterFactory } from '@/lib/ssh/adapters/factory';

const pool = new SSHConnectionPool();

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const { widgetId } = await params;
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';

  // Simple cache bypass for now - would use Redis in production
  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (widgetRes.values.length === 0) {
      return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    }

    const widget = rowsToObjects(widgetRes)[0];

    const serverRes = await rqlite.query('SELECT * FROM servers WHERE id = ?', [widget.server_id]);
    if (serverRes.values.length === 0) {
      return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    }

    const server = rowsToObjects(serverRes)[0];

    if (!server.ssh_key_id) {
      return NextResponse.json({ error: { message: 'Server has no SSH key configured' } }, { status: 400 });
    }

    const keyRes = await rqlite.query('SELECT * FROM ssh_keys WHERE id = ?', [server.ssh_key_id]);
    if (keyRes.values.length === 0) {
      return NextResponse.json({ error: { message: 'SSH key not found' } }, { status: 404 });
    }

    const key = rowsToObjects(keyRes)[0];
    const { decryptPrivateKey } = await import('@/lib/crypto/keys');
    const privateKey = decryptPrivateKey(key.private_key_enc);

    const sshConfig = {
      host: server.hostname,
      port: server.ssh_port || 22,
      username: server.ssh_user,
      privateKey
    };

    const runCommand = async (cmd: string) => {
      return pool.executeCommand(server.id, sshConfig, cmd);
    };

    let data;
    switch (widget.widget_type) {
      case 'server_summary': {
        const os = await runCommand('cat /etc/os-release');
        const info: Record<string, string> = {};
        os.stdout.split('\n').forEach(line => {
          const [key, ...rest] = line.split('=');
          if (key && rest.length) info[key] = rest.join('=').replace(/"/g, '');
        });
        data = { is_online: os.exitCode === 0, os_type: info.NAME || 'Unknown', hostname: server.hostname };
        break;
      }
      case 'os_info': {
        const [osRelease, kernel, hostname] = await Promise.all([
          runCommand('cat /etc/os-release'),
          runCommand('uname -r'),
          runCommand('hostname'),
        ]);
        const info: Record<string, string> = {};
        osRelease.stdout.split('\n').forEach(line => {
          const [k, ...rest] = line.split('=');
          if (k && rest.length) info[k] = rest.join('=').replace(/"/g, '');
        });
        data = {
          name: info.NAME || 'Unknown',
          version: info.VERSION_ID || info.VERSION || '',
          codename: info.VERSION_CODENAME || '',
          prettyName: info.PRETTY_NAME || info.NAME || '',
          kernel: kernel.stdout.trim(),
          architecture: (await runCommand('uname -m')).stdout.trim(),
          hostname: hostname.stdout.trim(),
        };
        break;
      }
      case 'cpu_memory': {
        const [cpu, mem] = await Promise.all([
          runCommand('cat /proc/cpuinfo | head -20'),
          runCommand('cat /proc/meminfo'),
        ]);

        let model = 'Unknown';
        let cores = 1;
        cpu.stdout.split('\n').forEach(line => {
          if (line.toLowerCase().includes('model name')) model = line.split(':')[1]?.trim() || model;
          if (line.toLowerCase().includes('processor')) cores++;
        });

        const memInfo: Record<string, string> = {};
        mem.stdout.split('\n').forEach(line => {
          const [k, ...rest] = line.split(':');
          if (k && rest.length) memInfo[k.trim()] = rest.join(':').replace('kB', '').trim();
        });

        const totalMB = Math.round(parseInt(memInfo.MemTotal || '0', 10) / 1024);
        const freeMB = Math.round(parseInt(memInfo.MemAvailable || memInfo.MemFree || '0', 10) / 1024);
        const usedMB = totalMB - freeMB;

        data = {
          cpu: { model, cores, usagePercent: 0, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0 },
          memory: { totalMB, usedMB, freeMB, availableMB: freeMB, usagePercent: Math.round((usedMB / totalMB) * 100) || 0 }
        };
        break;
      }
      case 'disk_usage': {
        const df = await runCommand("df -T --block-size=1M --output=source,fstype,size,used,avail,pcent,target | tail -n +2");
        const disks = df.stdout.split('\n')
          .filter(line => line.trim())
          .filter(line => !line.match(/^(tmpfs|devtmpfs|squashfs|overlay|snap)/))
          .map(line => {
            const [fs, type, size, used, avail, percent, mount] = line.trim().split(/\s+/);
            return { filesystem: fs, fsType: type, sizeMB: parseInt(size, 10), usedMB: parseInt(used, 10), availableMB: parseInt(avail, 10), mountPoint: mount, usagePercent: parseInt(percent, 10) };
          });
        data = disks;
        break;
      }
      case 'network': {
        const ip = await runCommand('ip -j addr show 2>/dev/null || ip addr show');
        if (ip.exitCode === 0 && ip.stdout.includes('"')) {
          try {
            const ifaces = JSON.parse(ip.stdout);
            data = ifaces
              .filter((i: any) => i.ifname !== 'lo')
              .map((i: any) => ({
                name: i.ifname,
                ipv4: i.addr_info?.filter((a: any) => a.family === 'inet').map((a: any) => a.local) || [],
                ipv6: i.addr_info?.filter((a: any) => a.family === 'inet6').map((a: any) => a.local) || [],
                macAddress: i.address || '',
                state: i.operstate || 'UNKNOWN',
                mtu: i.mtu
              }));
          } catch {
            data = [];
          }
        } else {
          data = [];
        }
        break;
      }
      case 'system_services': {
        const svc = await runCommand('systemctl list-units --type=service --no-pager --plain --no-legend --state=running');
        const services = svc.stdout.split('\n')
          .filter(line => line.trim())
          .map(line => {
            const [name, ...rest] = line.trim().split(/\s+/);
            return { name: name.replace('.service', ''), status: 'running' as const, description: rest.join(' ') };
          });
        data = services;
        break;
      }
      default:
        return NextResponse.json({ error: { message: `Unknown widget type: ${widget.widget_type}` } }, { status: 400 });
    }

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Widget data error:', error);
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}