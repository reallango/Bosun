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

const MARK = '@@BOSUN ';

/** Probes the script understands; the poller picks a subset per tick. */
const PROBES = ['stat', 'mem', 'load', 'temp', 'netdev', 'gpu', 'df', 'ip', 'docker', 'ollama', 'services', 'system', 'updates'];

const SCRIPT = String.raw`
export LC_ALL=C
m() { printf '\n@@BOSUN %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
for p in "$@"; do
case "$p" in
stat) m stat; head -n 1 /proc/stat; grep -c '^cpu[0-9]' /proc/stat ;;
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
gpu) m gpu
  if have nvidia-smi; then
    nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits 2>&1 | head -n 16
  else echo NONE; fi ;;
df) m df; df -P -T -k 2>/dev/null | tail -n +2 ;;
ip) m ip; if have ip; then ip -j addr show 2>/dev/null || echo NOJSON; else echo NONE; fi ;;
docker) m docker
  if have docker; then
    out=$(docker ps -a --no-trunc --format '{{json .}}' 2>&1); rc=$?
    if [ $rc -ne 0 ] && have sudo; then out2=$(sudo -n docker ps -a --no-trunc --format '{{json .}}' 2>&1) && { out=$out2; rc=0; }; fi
    echo "RC $rc"; printf '%s\n' "$out" | head -n 500
  else echo NONE; fi ;;
ollama) m ollama
  if have curl; then
    v=$(curl -s -m 3 http://127.0.0.1:11434/api/version 2>/dev/null)
    if [ -n "$v" ]; then
      echo "$v"
      curl -s -m 5 http://127.0.0.1:11434/api/tags 2>/dev/null; echo
      curl -s -m 3 http://127.0.0.1:11434/api/ps 2>/dev/null; echo
    else echo DOWN; fi
  else echo NOCURL; fi ;;
services) m services
  if have systemctl; then systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | head -n 400
  else echo NONE; fi ;;
system) m system
  cat /etc/os-release 2>/dev/null; echo "@@KERNEL $(uname -r)"; echo "@@ARCH $(uname -m)"; echo "@@HOST $(hostname 2>/dev/null || cat /etc/hostname)"
  echo "@@CPUS $(grep -c ^processor /proc/cpuinfo)"; echo "@@MODEL $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-)"
  echo "@@CORES $(grep -m1 'cpu cores' /proc/cpuinfo | cut -d: -f2-)" ;;
updates) m updates
  if have apt-get; then echo "MGR apt"; apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' | head -n 300
  elif have dnf; then echo "MGR dnf"; dnf -q check-update 2>/dev/null | head -n 300
  elif have yum; then echo "MGR yum"; yum -q check-update 2>/dev/null | head -n 300
  else echo "MGR none"; fi
  if [ -f /var/run/reboot-required ]; then echo "REBOOT 1"; fi ;;
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
  const [line, count] = text.split('\n');
  const f = (line || '').trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0);
  const total = f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total, threads: num(count, 1) };
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

function parseGpu(text) {
  if (!text || text === 'NONE') return [];
  return text.split('\n').map(l => l.split(',').map(s => s.trim())).filter(p => p.length >= 7 && /^\d+$/.test(p[0]))
    .map(p => {
      const n = v => (v === undefined || /N\/A|Not Supported|\[/.test(v) ? null : num(v, null));
      return {
        index: num(p[0]), name: p[1],
        vram_total_mb: n(p[2]) ?? 0, vram_used_mb: n(p[3]) ?? 0,
        utilization_percent: n(p[4]) ?? 0, temperature_c: n(p[5]) ?? 0,
        power_watts: n(p[6]) ?? 0, power_limit_watts: n(p[7]), fan_percent: n(p[8]),
      };
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

function parseIp(text) {
  if (!text || !text.startsWith('[')) return [];
  try {
    return JSON.parse(text).filter(i => i.ifname !== 'lo').map(i => ({
      name: i.ifname, state: i.operstate || 'UNKNOWN', mtu: i.mtu, macAddress: i.address || '',
      ipv4: (i.addr_info || []).filter(a => a.family === 'inet').map(a => a.local),
      ipv6: (i.addr_info || []).filter(a => a.family === 'inet6').map(a => a.local),
    }));
  } catch {
    return [];
  }
}

function parseDocker(text) {
  if (!text || text === 'NONE') return { available: false, error: 'docker not installed', containers: [] };
  const [first, ...rest] = text.split('\n');
  const rc = parseInt((first || '').replace('RC ', ''), 10);
  if (rc !== 0) {
    const err = rest.join(' ').trim().slice(0, 300);
    return { available: false, error: /permission denied/i.test(err) ? 'permission denied (add the SSH user to the docker group)' : err || 'docker ps failed', containers: [] };
  }
  const containers = [];
  for (const l of rest) {
    if (!l.startsWith('{')) continue;
    try {
      const c = JSON.parse(l);
      containers.push({
        id: String(c.ID || '').slice(0, 12), name: c.Names, image: c.Image, status: c.Status,
        state: c.State || (/^Up/.test(c.Status) ? 'running' : 'exited'), ports: c.Ports || '',
        createdAt: c.CreatedAt || '', runningFor: c.RunningFor || '',
        compose: (String(c.Labels || '').match(/com\.docker\.compose\.project=([^,]+)/) || [])[1] || null,
      });
    } catch { /* ignore malformed line */ }
  }
  containers.sort((a, b) => (a.state === b.state ? String(a.name).localeCompare(String(b.name)) : a.state === 'running' ? -1 : 1));
  return { available: true, containers };
}

function parseOllama(text) {
  if (!text || text === 'DOWN' || text === 'NOCURL') return { status: text === 'NOCURL' ? 'unknown' : 'stopped', models: [], running: [] };
  const [v, tags, ps] = text.split('\n');
  const safe = s => { try { return JSON.parse(s); } catch { return null; } };
  const version = (safe(v) || {}).version || null;
  const t = safe(tags);
  const p = safe(ps);
  if (!t) return { status: 'error', version, models: [], running: [] };
  const running = ((p && p.models) || []).map(m => ({ name: m.name, size: m.size, size_vram: m.size_vram, expires_at: m.expires_at }));
  const models = (t.models || []).map(m => ({
    name: m.name, size: m.size, modified_at: m.modified_at, digest: String(m.digest || '').slice(0, 12),
    family: m.details && m.details.family, parameter_size: m.details && m.details.parameter_size,
    quantization_level: m.details && m.details.quantization_level,
    loaded: running.some(r => r.name === m.name),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 'running', version, models, running };
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

function parseUpdates(text) {
  const [first, ...rest] = (text || '').split('\n');
  const mgr = (first || '').replace('MGR ', '').trim();
  let packages = [];
  if (mgr === 'apt') {
    // Inst <name> [<current>] (<new> <origin> [<arch>])
    packages = rest.filter(l => l.startsWith('Inst ')).map(l => {
      const mm = l.match(/^Inst (\S+)(?: \[([^\]]+)\])? \((\S+) ([^)]*)\)/);
      return mm
        ? { name: mm[1], current_version: mm[2] || '', new_version: mm[3], is_security: /security/i.test(mm[4]) }
        : { name: l.split(/\s+/)[1], current_version: '', new_version: '', is_security: false };
    });
  } else if (mgr === 'dnf' || mgr === 'yum') {
    // <name>.<arch>  <new version>  <repo>
    packages = rest.filter(l => /^\S+\.\S+\s+\S+\s+\S+/.test(l)).map(l => {
      const [name, version, repo] = l.trim().split(/\s+/);
      return { name, current_version: '', new_version: version, is_security: /security/i.test(repo || '') };
    });
  }
  // No timestamp here: collected_at already records when this ran, and a
  // volatile field would rewrite the snapshot on every check.
  return {
    manager: mgr || 'none',
    updatesAvailable: packages.length,
    securityUpdates: packages.filter(p => p.is_security).length,
    rebootRequired: rest.some(l => l.trim() === 'REBOOT 1'),
    packages: packages.slice(0, 200),
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
    const cpu = { model: sys.cpuModel || 'Unknown', cores: sys.cpuCores || 1, threads: sys.cpuThreads || 1, usagePercent: null,
      loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, temperature: null };
    if (raw.stat !== undefined) {
      const s = parseStat(raw.stat);
      cpu.threads = s.threads || cpu.threads;
      if (prev && prev.stat && s.total > prev.stat.total) {
        const dt = s.total - prev.stat.total;
        cpu.usagePercent = round1(Math.max(0, Math.min(100, ((dt - (s.idle - prev.stat.idle)) / dt) * 100)));
        metrics['cpu.usage'] = cpu.usagePercent;
      }
      state.stat = { idle: s.idle, total: s.total };
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
    sections.network = parseIp(raw.ip).map(i => ({ ...i, rxBps: rates[i.name] ? rates[i.name].rxBps : null, txBps: rates[i.name] ? rates[i.name].txBps : null }));
  }

  if (raw.gpu !== undefined) {
    const gpus = parseGpu(raw.gpu);
    sections.gpus = gpus;
    for (const g of gpus) {
      metrics[`gpu${g.index}.util`] = g.utilization_percent;
      metrics[`gpu${g.index}.vram_mb`] = g.vram_used_mb;
      metrics[`gpu${g.index}.temp`] = g.temperature_c;
      metrics[`gpu${g.index}.power_w`] = g.power_watts;
    }
  }

  if (raw.df !== undefined) {
    const disks = parseDf(raw.df);
    sections.disks = disks;
    const root = disks.find(d => d.mountPoint === '/');
    if (root) metrics['disk.root_used_pct'] = root.usagePercent;
    if (disks.length) metrics['disk.max_used_pct'] = Math.max(...disks.map(d => d.usagePercent));
  }

  if (raw.docker !== undefined) {
    const d = parseDocker(raw.docker);
    sections.docker = d;
    if (d.available) metrics['docker.running'] = d.containers.filter(c => c.state === 'running').length;
  }

  if (raw.ollama !== undefined) {
    const o = parseOllama(raw.ollama);
    sections.ollama = o;
    if (o.status === 'running') metrics['ollama.loaded'] = o.running.length;
  }

  if (raw.services !== undefined) sections.services = parseServices(raw.services);

  if (raw.system !== undefined) {
    const s = parseSystem(raw.system);
    sections.system = s;
    state.system = s;
  }

  if (raw.updates !== undefined) sections.updates = parseUpdates(raw.updates);

  return { sections, metrics, state };
}

module.exports = {
  PROBES,
  SCRIPT,
  buildCommand,
  splitSections,
  buildSnapshot,
  _parsers: { parseStat, parseMeminfo, parseLoad, parseTemp, parseNetdev, parseGpu, parseDf, parseIp, parseDocker, parseOllama, parseServices, parseSystem, parseUpdates },
};
