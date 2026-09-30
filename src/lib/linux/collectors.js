'use strict';

/**
 * Shared Linux widget data collectors.
 *
 * Dependency-free CommonJS so the Next.js widget route (TypeScript) and the
 * root poller.js can share one implementation and cannot drift apart.
 *
 * `run(cmd)` must resolve to { stdout, stderr, exitCode }. `cfg` carries the
 * widget config and, for `server_summary`, the server row under `cfg.server`.
 *
 * Every collector returns the exact JSON shape the React widgets consume.
 */

function parseOsRelease(text) {
  const p = {};
  text.split('\n').forEach(l => {
    const [k, ...v] = l.split('=');
    if (k && v.length) p[k.trim()] = v.join('=').replace(/"/g, '').trim();
  });
  return p;
}

async function getLinuxWidgetData(type, run, cfg = {}) {
  switch (type) {
    case 'server_summary': {
      const s = cfg.server || {};
      return {
        is_online: !!s.is_online,
        hostname: s.hostname,
        os_type: s.os_type,
        os_version: s.os_version,
        name: s.name,
      };
    }

    case 'os_info': {
      const [osr, kern, arch, hn, up] = await Promise.all([
        run('cat /etc/os-release'),
        run('uname -r'),
        run('uname -m'),
        run('hostname'),
        run('cat /proc/uptime'),
      ]);
      const p = parseOsRelease(osr.stdout);
      const sec = parseFloat(up.stdout.split(' ')[0] || '0');
      return {
        name: p['NAME'] || 'Linux',
        version: p['VERSION_ID'] || '',
        codename: p['VERSION_CODENAME'] || '',
        prettyName: p['PRETTY_NAME'] || 'Linux',
        kernel: kern.stdout.trim(),
        architecture: arch.stdout.trim(),
        hostname: hn.stdout.trim(),
        uptime: `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h ${Math.floor((sec % 3600) / 60)}m`,
        uptimeSeconds: sec,
      };
    }

    case 'cpu_memory': {
      const [lscpu, meminfo, loadavg, temp] = await Promise.all([
        run('lscpu 2>/dev/null||echo none'),
        run('cat /proc/meminfo'),
        run('cat /proc/loadavg'),
        run('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null||echo 0'),
      ]);
      let cpuModel = 'Unknown', cores = 1, threads = 1;
      lscpu.stdout.split('\n').forEach(l => {
        if (l.startsWith('Model name:')) cpuModel = l.split(':')[1]?.trim() || cpuModel;
        if (l.startsWith('CPU(s):')) cores = parseInt(l.split(':')[1]?.trim() || '1', 10);
        if (l.startsWith('Thread(s) per core:')) threads = parseInt(l.split(':')[1]?.trim() || '1', 10) * cores;
      });
      const s1 = await run('head -1 /proc/stat');
      await new Promise(r => setTimeout(r, 500));
      const s2 = await run('head -1 /proc/stat');
      const ps = s => s.trim().split(/\s+/).slice(1).map(Number);
      const a = ps(s1.stdout), b = ps(s2.stdout);
      const td = b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0);
      const id2 = (b[3] + (b[4] || 0)) - (a[3] + (a[4] || 0));
      const cpuPct = td > 0 ? ((td - id2) / td) * 100 : 0;
      const ml = {};
      meminfo.stdout.split('\n').forEach(l => { const m = l.match(/^(\w+):\s+(\d+)/); if (m) ml[m[1]] = parseInt(m[2], 10); });
      const tMB = Math.round((ml['MemTotal'] || 0) / 1024);
      const aMB = Math.round((ml['MemAvailable'] || ml['MemFree'] || 0) / 1024);
      const uMB = tMB - aMB;
      const [l1, l5, l15] = loadavg.stdout.trim().split(/\s+/).map(Number);
      const t = parseInt(temp.stdout.trim(), 10) / 1000;
      return {
        cpu: {
          model: cpuModel, cores, threads,
          usagePercent: Math.round(cpuPct * 10) / 10,
          loadAvg1: l1, loadAvg5: l5, loadAvg15: l15,
          temperature: t > 0 ? t : null,
        },
        memory: {
          totalMB: tMB, usedMB: uMB, freeMB: tMB - uMB, availableMB: aMB,
          usagePercent: tMB > 0 ? Math.round((uMB / tMB) * 1000) / 10 : 0,
          swapTotalMB: Math.round((ml['SwapTotal'] || 0) / 1024),
          swapUsedMB: Math.round(((ml['SwapTotal'] || 0) - (ml['SwapFree'] || 0)) / 1024),
        },
      };
    }

    case 'disk_usage': {
      const df = await run("df -T --block-size=1M --output=source,fstype,size,used,avail,pcent,target 2>/dev/null|tail -n +2");
      return df.stdout.trim().split('\n').filter(Boolean)
        .map(l => {
          const p = l.trim().split(/\s+/);
          return {
            filesystem: p[0], fsType: p[1], sizeMB: +p[2], usedMB: +p[3], availableMB: +p[4],
            usagePercent: parseInt((p[5] || '0').replace('%', ''), 10),
            mountPoint: p.slice(6).join(' '),
          };
        })
        .filter(d => !['tmpfs', 'devtmpfs', 'squashfs', 'overlay'].includes(d.fsType) && !d.mountPoint.startsWith('/snap'));
    }

    case 'network': {
      const ip = await run('ip -j addr show 2>/dev/null');
      if (ip.exitCode === 0 && ip.stdout.trim().startsWith('[')) {
        return JSON.parse(ip.stdout).filter(i => i.ifname !== 'lo').map(i => ({
          name: i.ifname,
          state: i.operstate || 'UNKNOWN',
          mtu: i.mtu,
          macAddress: i.address || '',
          ipv4: (i.addr_info || []).filter(a => a.family === 'inet').map(a => a.local),
          ipv6: (i.addr_info || []).filter(a => a.family === 'inet6').map(a => a.local),
        }));
      }
      return [];
    }

    case 'system_services': {
      const f = cfg.filter || 'running';
      const cmd = f === 'running'
        ? 'systemctl list-units --type=service --state=running --no-pager --plain --no-legend'
        : 'systemctl list-units --type=service --no-pager --plain --no-legend';
      const r = await run(cmd);
      return r.stdout.trim().split('\n').filter(Boolean).map(l => {
        const p = l.trim().split(/\s+/);
        return {
          name: (p[0] || '').replace('.service', ''),
          status: p[2] === 'running' ? 'running' : p[2] === 'failed' ? 'failed' : 'stopped',
          description: p.slice(4).join(' '),
          enabled: p[1] === 'loaded',
        };
      });
    }

    case 'gpu_monitoring': {
      const r = await run('nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader 2>/dev/null');
      if (r.exitCode === 0 && r.stdout.trim()) {
        const parts = r.stdout.trim().split(',').map(p => p.trim());
        return {
          name: parts[0],
          vram_total_mb: parseInt(parts[1] || '0', 10),
          vram_used_mb: parseInt(parts[2] || '0', 10),
          utilization_percent: parseInt(parts[3] || '0', 10),
          temperature_c: parseInt(parts[4] || '0', 10),
          power_watts: parseFloat(parts[5] || '0'),
        };
      }
      return { name: 'No GPU', vram_total_mb: 0, vram_used_mb: 0, utilization_percent: 0, temperature_c: 0, power_watts: 0 };
    }

    case 'ollama_status': {
      const check = await run('curl -s http://localhost:11434/api/tags 2>/dev/null');
      if (check.exitCode !== 0) return { status: 'stopped', models: [] };
      let data;
      try {
        const tags = JSON.parse(check.stdout);
        data = { status: 'running', models: tags.models || [] };
      } catch {
        data = { status: 'error', models: [] };
      }
      const pgrep = await run("pgrep -a 'ollama pull' 2>/dev/null || true");
      if (pgrep.exitCode === 0 && pgrep.stdout.trim()) {
        data = { ...data, pulling: { name: 'unknown', progress: 0 } };
      }
      return data;
    }

    case 'docker_containers': {
      const r1 = await run("docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}' 2>/dev/null || true");
      let r = r1;
      if (r1.exitCode !== 0) {
        const r2 = await run("sudo docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}' 2>/dev/null || true");
        if (r2.exitCode === 0) r = r2;
      }
      if (r.exitCode !== 0) {
        const r3 = await run("podman ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}' 2>/dev/null || true");
        if (r3.exitCode === 0) r = r3;
      }
      if (r.exitCode !== 0) return [];
      return r.stdout.trim().split('\n').filter(Boolean).map(line => {
        const p = line.split('|');
        return { id: p[0], name: p[1], image: p[2], status: p[3], state: p[4], ports: p[5] };
      });
    }

    case 'custom_command': {
      const cmd = cfg.command || 'uptime';
      const r = await run(cmd);
      return { output: r.stdout + r.stderr, exitCode: r.exitCode };
    }

    case 'os_update_check': {
      const osType = (cfg.server && cfg.server.os_type) || 'ubuntu';
      let checkCmd = 'apt-get -s upgrade 2>&1 | grep -i "upgraded\\|installed\\|kept back" | wc -l';
      if (osType.includes('rhel') || osType.includes('centos') || osType.includes('fedora')) {
        checkCmd = 'yum check-update 2>&1 | wc -l';
      }
      const r = await run(checkCmd);
      const updateCount = parseInt(r.stdout.trim() || '0', 10) || 0;

      let listCmd = 'apt-get -s upgrade 2>&1 | grep "^Inst" | awk "{print \\$2}" | head -10';
      if (osType.includes('rhel') || osType.includes('centos') || osType.includes('fedora')) {
        listCmd = 'yum list updates 2>&1 | tail -n +2 | head -10';
      }
      const lr = await run(listCmd);
      const packages = lr.stdout.trim().split('\n').filter(Boolean);

      return { updatesAvailable: updateCount, packages, lastCheck: new Date().toISOString() };
    }

    default:
      return undefined;
  }
}

module.exports = { getLinuxWidgetData };
