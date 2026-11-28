'use strict';

/**
 * Batched Linux collection.
 *
 * One SSH exec per poll: a POSIX sh script (sent on stdin, so no quoting
 * issues) prints every requested probe under an `@@BOSUN <name>` marker. It
 * only reads /proc and /sys and runs a few cheap read-only tools, at the
 * lowest CPU and I/O priority (nice 19, ionice idle where available).
 *
 * Dependency-free CommonJS: shared by poller.js and the Next.js server.
 */

const macs = require('./macs');
const { metricsSection, withSlowMetrics } = require('./metrics-section');

const MARK = '@@BOSUN ';

/** Probes the script understands; the poller picks a subset per tick. */
const PROBES = ['stat', 'mem', 'load', 'temp', 'netdev', 'diskstats', 'gpu', 'df', 'ip', 'services', 'system'];

const SCRIPT = String.raw`
export LC_ALL=C
m() { printf '\n@@BOSUN %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
for p in "$@"; do
case "$p" in
stat) m stat; head -n 1 /proc/stat; grep '^cpu[0-9]' /proc/stat ;;
mem) m mem; cat /proc/meminfo ;;
load) m load; cat /proc/loadavg; cat /proc/uptime ;;
temp) m temp
  for z in /sys/class/thermal/thermal_zone*; do
    [ -r "$z/temp" ] || continue
    printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"
  done
  for h in /sys/class/hwmon/hwmon*; do
    n=$(cat "$h/name" 2>/dev/null)
    case "$n" in coretemp|k10temp|zenpower|cpu_thermal) [ -r "$h/temp1_input" ] && printf '%s %s\n' "$n" "$(cat "$h/temp1_input")" ;; esac
  done ;;
netdev) m netdev; cat /proc/net/dev ;;
diskstats) m diskstats; cat /proc/diskstats ;;
gpu) m gpu
  if have nvidia-smi; then
    nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits 2>&1 | head -n 16
  else echo NONE; fi ;;
df) m df; df -P -T -k 2>/dev/null | tail -n +2 ;;
ip) m ip
  echo "SSHCONN $SSH_CONNECTION"
  printf "PHYS"; for d in /sys/class/net/*; do [ -e "$d/device" ] && printf " %s" "$(basename "$d")"; done; echo
  printf "WIFI"; for d in /sys/class/net/*; do [ -e "$d/wireless" ] && printf " %s" "$(basename "$d")"; done; echo
  if have ip; then
    echo "DEFAULT $(ip route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1)"
    ip -j addr show 2>/dev/null || echo NOJSON
  else
    echo "DEFAULT $(awk '$2=="00000000" {print $1; exit}' /proc/net/route 2>/dev/null)"
    echo NONE
  fi ;;
services) m services
  if have systemctl; then systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | head -n 400
  else echo NONE; fi ;;
system) m system
  cat /etc/os-release 2>/dev/null; echo "@@KERNEL $(uname -r)"; echo "@@ARCH $(uname -m)"; echo "@@HOST $(hostname 2>/dev/null || cat /etc/hostname)"
  echo "@@CPUS $(grep -c ^processor /proc/cpuinfo)"; echo "@@MODEL $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-)"
  echo "@@CORES $(grep -m1 'cpu cores' /proc/cpuinfo | cut -d: -f2-)" ;;
esac
done
m end
`;

/**
 * The remote command. The script arrives on stdin; the probe names are
 * validated so nothing user-controlled reaches the shell.
 */
function buildCommand(probes) {
  const list = probes.filter(p => PROBES.includes(p)).join(' ');
  return 'if command -v ionice >/dev/null 2>&1; then exec nice -n 19 ionice -c 3 sh -s ' + list +
    '; else exec nice -n 19 sh -s ' + list + '; fi';
}

/** Split script output into { probe: text }. */
function splitSections(stdout) {
  const out = {};
  let cur = null;
  let buf = [];
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith(MARK)) {
      if (cur) out[cur] = buf.join('\n').trim();
      cur = line.slice(MARK.length).trim();
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  if (cur && cur !== 'end') out[cur] = buf.join('\n').trim();
  delete out.end;
  return out;
}

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round1 = v => Math.round(v * 10) / 10;

function parseStat(text) {
  const lines = String(text).split('\n').filter(l => l.trim());
  const f = (lines[0] || '').trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0);
  const total = f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  // One line per logical CPU (`cpu0`, `cpu1`, ...); the counts are the same ticks as the `cpu` line.
  const cores = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    const m = (parts[0] || '').match(/^cpu(\d+)$/);
    if (!m) continue;
    const c = parts.slice(1).map(Number);
    cores.push({
      id: num(m[1]),
      idle: (c[3] || 0) + (c[4] || 0),
      total: c.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0),
    });
  }
  return { idle, total, threads: cores.length || 1, cores };
}

function parseMeminfo(text) {
  const kv = {};
  for (const l of text.split('\n')) {
    const mm = l.match(/^(\w+):\s+(\d+)/);
    if (mm) kv[mm[1]] = parseInt(mm[2], 10);
  }
  const totalMB = Math.round((kv.MemTotal || 0) / 1024);
  const availableMB = Math.round((kv.MemAvailable ?? kv.MemFree ?? 0) / 1024);
  const usedMB = totalMB - availableMB;
  const swapTotalMB = Math.round((kv.SwapTotal || 0) / 1024);
  return {
    totalMB, usedMB, freeMB: Math.round((kv.MemFree || 0) / 1024), availableMB,
    usagePercent: totalMB > 0 ? round1((usedMB / totalMB) * 100) : 0,
    swapTotalMB,
    swapUsedMB: swapTotalMB - Math.round((kv.SwapFree || 0) / 1024),
    cachedMB: Math.round(((kv.Cached || 0) + (kv.Buffers || 0)) / 1024),
  };
}

function parseLoad(text) {
  const [la, up] = text.split('\n');
  const [l1, l5, l15] = (la || '').trim().split(/\s+/).map(Number);
  return { loadAvg1: num(l1), loadAvg5: num(l5), loadAvg15: num(l15), uptimeSeconds: Math.floor(num((up || '').split(' ')[0])) };
}

/** Prefer a CPU package sensor; fall back to the first plausible zone. */
function parseTemp(text) {
  const rows = text.split('\n').map(l => l.trim().split(/\s+/)).filter(r => r.length >= 2)
    .map(([type, v]) => ({ type, c: num(v) / 1000 })).filter(r => r.c > 0 && r.c < 150);
  const pref = rows.find(r => /x86_pkg_temp|coretemp|k10temp|zenpower|cpu/i.test(r.type));
  return (pref || rows[0] || { c: null }).c;
}

const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|tun|tap|kube|vnet)/;

function parseNetdev(text) {
  const ifs = {};
  for (const l of text.split('\n').slice(2)) {
    const mm = l.match(/^\s*([^:]+):\s*(.*)$/);
    if (!mm) continue;
    const f = mm[2].trim().split(/\s+/).map(Number);
    ifs[mm[1].trim()] = { rx: f[0] || 0, tx: f[8] || 0 };
  }
  return ifs;
}

/** `/proc/diskstats` sectors are 512 bytes each, whatever the device's physical sector size. */
const DISK_SECTOR_BYTES = 512;
/** Whole disks (not partitions, dm/md/loop devices), so the totals are not counted twice. */
const WHOLE_DISK_RE = /^(?:sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** Per-device cumulative sector counters from `/proc/diskstats`. */
function parseDiskstats(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const name = p[2];
    if (!name) continue;
    out[name] = { readSectors: num(p[5]), writeSectors: num(p[9]) };
  }
  return out;
}

/** The device a mount's filesystem lives on: its diskstats name, else the longest whole-disk prefix (`sda2` -> `sda`). */
function deviceForMount(filesystem, names) {
  const base = String(filesystem || '').replace(/^\/dev\//, '');
  if (!base || base.startsWith('mapper/')) return null;
  if (names.has(base)) return base;
  let best = null;
  for (const n of names) if (base.startsWith(n) && (!best || n.length > best.length)) best = n;
  return best;
}

function parseGpu(text) {
  if (!text || text === 'NONE') return [];
  return text.split('\n').map(l => l.split(',').map(s => s.trim())).filter(p => p.length >= 7 && /^\d+$/.test(p[0]))
    .map(p => {
      const n = v => (v === undefined || /N\/A|Not Supported|\[/.test(v) ? null : num(v, null));
      const g = {
        index: num(p[0]), name: p[1],
        vram_total_mb: n(p[2]) ?? 0, vram_used_mb: n(p[3]) ?? 0,
        utilization_percent: n(p[4]) ?? 0, temperature_c: n(p[5]) ?? 0,
        power_watts: n(p[6]) ?? 0, power_limit_watts: n(p[7]), fan_percent: n(p[8]),
      };
      g.vram_percent = g.vram_total_mb > 0 ? Math.round((g.vram_used_mb / g.vram_total_mb) * 100) : 0;
      return g;
    });
}

const SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'efivarfs', 'ramfs', 'nsfs', 'fuse.lxcfs', 'autofs', 'tracefs', 'cgroup', 'cgroup2']);

function parseDf(text) {
  const seen = new Set();
  return text.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 7)
    .map(p => ({
      filesystem: p[0], fsType: p[1],
      sizeMB: Math.round(num(p[2]) / 1024), usedMB: Math.round(num(p[3]) / 1024), availableMB: Math.round(num(p[4]) / 1024),
      usagePercent: parseInt(String(p[5]).replace('%', ''), 10) || 0,
      mountPoint: p.slice(6).join(' '),
    }))
    .filter(d => !SKIP_FS.has(d.fsType) && d.sizeMB > 0 && !d.mountPoint.startsWith('/snap') &&
      !d.mountPoint.startsWith('/var/lib/docker') && !d.mountPoint.startsWith('/run') && !d.mountPoint.startsWith('/boot/efi'))
    .filter(d => (seen.has(d.filesystem) ? false : (seen.add(d.filesystem), true)));
}

/**
 * `ip` probe: SSHCONN/PHYS/WIFI metadata lines, then `ip -j addr` JSON.
 * Returns { interfaces, serverIp }; interfaces are flagged physical (has a
 * /sys device) and wireless (has /sys wireless).
 */
function parseIpProbe(text) {
  const meta = { SSHCONN: '', PHYS: '', WIFI: '', DEFAULT: '' };
  let json = '';
  for (const line of String(text || '').split('\n')) {
    const mm = line.match(/^(SSHCONN|PHYS|WIFI|DEFAULT)\b ?(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
    else if (line.trim().startsWith('[')) json = line.trim();
  }
  const phys = new Set(meta.PHYS.split(/\s+/).filter(Boolean));
  const wifi = new Set(meta.WIFI.split(/\s+/).filter(Boolean));
  let interfaces = [];
  if (json) {
    try {
      interfaces = JSON.parse(json).filter(i => i.ifname !== 'lo').map(i => ({
        name: i.ifname, state: i.operstate || 'UNKNOWN', mtu: i.mtu, macAddress: i.address || '',
        ipv4: (i.addr_info || []).filter(a => a.family === 'inet').map(a => a.local),
        ipv6: (i.addr_info || []).filter(a => a.family === 'inet6').map(a => a.local),
        physical: phys.size ? phys.has(i.ifname) : !VIRTUAL_IF.test(i.ifname),
        wireless: wifi.has(i.ifname) || /^wl/.test(i.ifname),
        default: !!meta.DEFAULT && meta.DEFAULT === i.ifname,
      }));
    } catch {
      interfaces = [];
    }
  }
  return { interfaces, serverIp: macs.serverIpFromSshConnection(meta.SSHCONN), defaultInterface: meta.DEFAULT || null };
}

function parseIp(text) {
  return parseIpProbe(text).interfaces;
}

function parseServices(text) {
  if (!text || text === 'NONE') return [];
  return text.split('\n').filter(Boolean).map(l => {
    const p = l.trim().split(/\s+/);
    const sub = p[3];
    return {
      name: (p[0] || '').replace(/\.service$/, ''),
      status: sub === 'running' ? 'running' : p[2] === 'failed' ? 'failed' : 'stopped',
      description: p.slice(4).join(' '),
      enabled: p[1] === 'loaded',
    };
  }).filter(s => s.name && !s.name.startsWith('●'));
}

function parseSystem(text) {
  const kv = {};
  const meta = {};
  for (const l of text.split('\n')) {
    const mm = l.match(/^@@(\w+) ?(.*)$/);
    if (mm) { meta[mm[1]] = mm[2].trim(); continue; }
    const [k, ...v] = l.split('=');
    if (k && v.length) kv[k.trim()] = v.join('=').replace(/^"|"$/g, '').trim();
  }
  const threads = num(meta.CPUS, 1);
  return {
    name: kv.NAME || 'Linux', id: kv.ID || 'linux', version: kv.VERSION_ID || '', codename: kv.VERSION_CODENAME || '',
    prettyName: kv.PRETTY_NAME || kv.NAME || 'Linux',
    kernel: meta.KERNEL || '', architecture: meta.ARCH || '', hostname: meta.HOST || '',
    cpuModel: (meta.MODEL || 'Unknown').trim(), cpuThreads: threads, cpuCores: num(meta.CORES, threads) || threads,
  };
}

/**
 * Turn raw probe output into snapshot sections + numeric metrics.
 *
 * `prev` is the per-host state from the previous poll (CPU and network
 * counters); rates and CPU% are deltas against it, so no probe has to sleep
 * on the remote host. Returns { sections, metrics, state }.
 */
function buildSnapshot(raw, prev, now = Date.now()) {
  /** @type {Record<string, any>} */
  const sections = {};
  /** @type {Record<string, number>} */
  const metrics = {};
  /** @type {Record<string, any>} */
  const state = { ...(prev || {}) };

  if (raw.stat !== undefined || raw.mem !== undefined) {
    const sys = (prev && prev.system) || {};
    const cpu = { model: sys.cpuModel || 'Unknown', coreCount: sys.cpuCores || 1, cores: [], threads: sys.cpuThreads || 1, usagePercent: null,
      loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, temperature: null };
    if (raw.stat !== undefined) {
      const s = parseStat(raw.stat);
      cpu.threads = s.threads || cpu.threads;
      if (prev && prev.stat && s.total > prev.stat.total) {
        const dt = s.total - prev.stat.total;
        cpu.usagePercent = round1(Math.max(0, Math.min(100, ((dt - (s.idle - prev.stat.idle)) / dt) * 100)));
        metrics['cpu.usage'] = cpu.usagePercent;
      }
      // Per-core usage from the same deltas as the total. This is a snapshot only: no per-core history is recorded.
      const before = new Map(((prev && prev.stat && prev.stat.cores) || []).map(c => [c.id, c]));
      cpu.cores = s.cores.map(c => {
        const p = before.get(c.id);
        if (!p || c.total <= p.total) return { id: c.id, usagePercent: null };
        const dt = c.total - p.total;
        return { id: c.id, usagePercent: round1(Math.max(0, Math.min(100, ((dt - (c.idle - p.idle)) / dt) * 100))) };
      });
      state.stat = { idle: s.idle, total: s.total, cores: s.cores };
    }
    if (raw.load !== undefined) {
      const l = parseLoad(raw.load);
      Object.assign(cpu, { loadAvg1: l.loadAvg1, loadAvg5: l.loadAvg5, loadAvg15: l.loadAvg15 });
      state.uptimeSeconds = l.uptimeSeconds;
      metrics['cpu.load1'] = l.loadAvg1;
    }
    if (raw.temp !== undefined) {
      cpu.temperature = parseTemp(raw.temp);
      if (cpu.temperature !== null) metrics['cpu.temp'] = round1(cpu.temperature);
    }
    const memory = raw.mem !== undefined ? parseMeminfo(raw.mem) : null;
    if (memory) {
      metrics['mem.used_pct'] = memory.usagePercent;
      metrics['mem.used_mb'] = memory.usedMB;
      if (memory.swapTotalMB > 0) metrics['swap.used_mb'] = memory.swapUsedMB;
    }
    sections.cpu_memory = { cpu, memory: memory || (prev && prev.memory) || null, uptimeSeconds: state.uptimeSeconds ?? null };
    if (memory) state.memory = memory;
  }

  if (raw.netdev !== undefined) {
    const ifs = parseNetdev(raw.netdev);
    const t = now / 1000;
    const rates = {};
    let rxTotal = 0;
    let txTotal = 0;
    if (prev && prev.net && t > prev.net.t) {
      const dt = t - prev.net.t;
      for (const [name, c] of Object.entries(ifs)) {
        const p = prev.net.ifs[name];
        if (!p || c.rx < p.rx || c.tx < p.tx) continue; // new interface or counter reset
        rates[name] = { rxBps: Math.round((c.rx - p.rx) / dt), txBps: Math.round((c.tx - p.tx) / dt) };
        if (!VIRTUAL_IF.test(name)) { rxTotal += rates[name].rxBps; txTotal += rates[name].txBps; }
      }
      metrics['net.rx_bps'] = rxTotal;
      metrics['net.tx_bps'] = txTotal;
    }
    state.net = { t, ifs };
    state.netRates = rates;
    sections.net_rates = { rates, rxBps: rxTotal, txBps: txTotal };
  }

  if (raw.ip !== undefined) {
    const rates = state.netRates || {};
    const probe = parseIpProbe(raw.ip);
    sections.network = probe.interfaces.map(i => ({ ...i, rxBps: rates[i.name] ? rates[i.name].rxBps : null, txBps: rates[i.name] ? rates[i.name].txBps : null }));
    // The main interface (the default route) and its IPv4, for a one-line network headline.
    const main = probe.interfaces.find(i => i.default)
      || probe.interfaces.find(i => i.physical && i.state === 'UP' && i.ipv4.length)
      || probe.interfaces.find(i => i.ipv4.length);
    if (main) sections.network_headline = { name: main.name, ipv4: main.ipv4[0] ?? null, state: main.state, macAddress: main.macAddress };
    // Wake-on-LAN candidates (primary = NIC the SSH connection arrived on).
    sections.nics = macs.pickMacs(probe.interfaces.map(i => ({
      name: i.name, mac: i.macAddress, physical: i.physical, wireless: i.wireless, up: i.state === 'UP', ipv4: i.ipv4,
    })), probe.serverIp);
  }

  if (raw.gpu !== undefined) {
    const gpus = parseGpu(raw.gpu);
    sections.gpus = gpus;
    for (const g of gpus) {
      metrics[`gpu${g.index}.util`] = g.utilization_percent;
      metrics[`gpu${g.index}.vram_mb`] = g.vram_used_mb;
      metrics[`gpu${g.index}.vram_pct`] = g.vram_percent;
      metrics[`gpu${g.index}.temp`] = g.temperature_c;
      metrics[`gpu${g.index}.power_w`] = g.power_watts;
    }
  }

  if (raw.diskstats !== undefined) {
    const devices = parseDiskstats(raw.diskstats);
    const t = now / 1000;
    const rates = {};
    if (prev && prev.diskio && t > prev.diskio.t) {
      const dt = t - prev.diskio.t;
      for (const [name, c] of Object.entries(devices)) {
        const p = prev.diskio.devices[name];
        if (!p || c.readSectors < p.readSectors || c.writeSectors < p.writeSectors) continue; // new device or counter reset
        rates[name] = {
          readBps: Math.round(((c.readSectors - p.readSectors) * DISK_SECTOR_BYTES) / dt),
          writeBps: Math.round(((c.writeSectors - p.writeSectors) * DISK_SECTOR_BYTES) / dt),
        };
      }
      // Whole disks only: partitions and dm/md devices would count the same bytes twice.
      let readBps = 0;
      let writeBps = 0;
      for (const [name, r] of Object.entries(rates)) {
        if (!WHOLE_DISK_RE.test(name)) continue;
        readBps += r.readBps;
        writeBps += r.writeBps;
      }
      metrics['disk.read_bps'] = readBps;
      metrics['disk.write_bps'] = writeBps;
    }
    state.diskio = { t, devices };
    state.diskRates = rates;
    sections.disk_io = {
      readBps: metrics['disk.read_bps'] ?? 0, writeBps: metrics['disk.write_bps'] ?? 0,
      devices: Object.entries(rates).map(([name, r]) => ({ name, ...r })),
    };
  }

  if (raw.df !== undefined) {
    const disks = parseDf(raw.df);
    const rates = state.diskRates || {};
    const names = new Set(Object.keys(rates));
    sections.disks = disks.map(d => {
      const dev = deviceForMount(d.filesystem, names);
      return dev ? { ...d, readBps: rates[dev].readBps, writeBps: rates[dev].writeBps } : d;
    });
    const root = disks.find(d => d.mountPoint === '/');
    if (root) metrics['disk.root_used_pct'] = root.usagePercent;
    if (disks.length) metrics['disk.max_used_pct'] = Math.max(...disks.map(d => d.usagePercent));
  }

  if (raw.services !== undefined) sections.services = parseServices(raw.services);

  if (raw.system !== undefined) {
    const s = parseSystem(raw.system);
    sections.system = s;
    state.system = s;
  }

  sections.metrics = metricsSection(withSlowMetrics(metrics, state), state.uptimeSeconds);
  return { sections, metrics, state };
}

module.exports = {
  PROBES,
  SCRIPT,
  buildCommand,
  splitSections,
  buildSnapshot,
  _parsers: { parseStat, parseMeminfo, parseLoad, parseTemp, parseNetdev, parseDiskstats, deviceForMount, parseGpu, parseDf, parseIp, parseIpProbe, parseServices, parseSystem },
};
