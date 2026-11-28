'use strict';

/**
 * Batched Windows collection over OpenSSH + PowerShell.
 *
 * One `powershell -EncodedCommand` exec per poll (no quoting issues). Every
 * probe prints compact JSON under the same `@@BOSUN <name>` markers as the
 * Linux script, and the sections are normalised to the Linux shapes so the
 * widgets do not care about the platform. CPU and network use raw perf
 * counters and are turned into rates by diffing against the previous poll, so
 * nothing sleeps on the host. The process runs at BelowNormal priority.
 */

const zlib = require('zlib');
const linux = require('./linux');
const macs = require('./macs');
const { metricsSection, withSlowMetrics } = require('./metrics-section');
const { splitSections } = linux;

const PROBES = ['stat', 'mem', 'netdev', 'diskstats', 'gpu', 'df', 'ip', 'services', 'system'];

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
function M($n) { Write-Output ("@@BOSUN " + $n) }
function J($o) { Write-Output ($o | ConvertTo-Json -Compress -Depth 4) }
foreach ($p in $Probes) {
  switch ($p) {
    'stat' { M 'stat'
      $c = @(Get-CimInstance Win32_PerfRawData_PerfOS_Processor)
      $t = $c | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
      $os = Get-CimInstance Win32_OperatingSystem
      J @{ busy100ns = [double]$t.PercentProcessorTime; ts100ns = [double]$t.Timestamp_Sys100NS; threads = [Environment]::ProcessorCount;
           uptimeSeconds = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds;
           cores = @($c | Where-Object { $_.Name -ne '_Total' } | ForEach-Object { @{ id = $_.Name; busy100ns = [double]$_.PercentProcessorTime; ts100ns = [double]$_.Timestamp_Sys100NS } }) } }
    'mem' { M 'mem'
      $os = Get-CimInstance Win32_OperatingSystem
      J @{ totalKB = [double]$os.TotalVisibleMemorySize; freeKB = [double]$os.FreePhysicalMemory;
           pageTotalKB = [double]$os.SizeStoredInPagingFiles; pageFreeKB = [double]$os.FreeSpaceInPagingFiles } }
    'netdev' { M 'netdev'
      J @(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | ForEach-Object { @{ name = $_.Name; rx = [double]$_.BytesReceivedPersec; tx = [double]$_.BytesSentPersec } }) }
    'gpu' { M 'gpu'
      $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
      if ($smi) { & $smi.Source --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits | Select-Object -First 16 }
      else { Write-Output 'NONE' } }
    'diskstats' { M 'diskstats'
      J @(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | ForEach-Object { @{ name = $_.Name; read = [double]$_.DiskReadBytesPersec; write = [double]$_.DiskWriteBytesPersec } }) }
    'df' { M 'df'
      J @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ id = $_.DeviceID; fs = $_.FileSystem; size = [double]$_.Size; free = [double]$_.FreeSpace; label = $_.VolumeName } }) }
    'ip' { M 'ip'
      Write-Output ("SSHCONN " + $env:SSH_CONNECTION)
      $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
      Write-Output ("DEFAULT " + $(if ($route) { [int]$route.InterfaceIndex } else { -1 }))
      $cfgs = @{}; Get-CimInstance Win32_NetworkAdapterConfiguration | ForEach-Object { $cfgs[[int]$_.Index] = $_ }
      J @(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' | Where-Object { $_.MACAddress } | ForEach-Object {
        $c = $cfgs[[int]$_.Index]
        @{ name = $_.NetConnectionID; desc = $_.Name; mac = $_.MACAddress; idx = [int]$_.Index; up = ($_.NetConnectionStatus -eq 2); ips = @(if ($c -and $c.IPAddress) { $c.IPAddress }) } }) }
    'services' { M 'services'
      J @(Get-Service | Select-Object -First 400 | ForEach-Object { @{ name = $_.Name; status = [string]$_.Status; display = $_.DisplayName; start = [string]$_.StartType } }) }
    'system' { M 'system'
      $os = Get-CimInstance Win32_OperatingSystem; $cpu = @(Get-CimInstance Win32_Processor)
      J @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture; host = $env:COMPUTERNAME;
           model = $cpu[0].Name; cores = ($cpu | Measure-Object NumberOfCores -Sum).Sum; threads = ($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum } }
  }
}
M 'end'
`;

// Windows OpenSSH runs an exec request through cmd.exe by default, and cmd.exe refuses
// command lines over 8191 characters ("The command line is too long."): the command
// never runs, there is no output, and the poller sees a failed poll every time. A
// UTF-16 + base64 -EncodedCommand is about 2.7x the script, so scripts over ~2.5 KB
// (the collector is 3.6 KB) need a more compact encoding.
const MAX_ENCODED_COMMAND_CHARS = 7000;
const MAX_COMMAND_CHARS = 8000;

/**
 * Build the `powershell.exe` command line that runs `script`.
 * Short scripts use -EncodedCommand (UTF-16, base64). Longer ones are gzipped
 * and base64-encoded inside a small bootstrap that decompresses and runs them;
 * base64 contains only characters that are safe for cmd.exe.
 */
function execScript(script, flags = '') {
  const text = String(script);
  const prefix = `powershell.exe -NoLogo -NoProfile -NonInteractive${flags ? ` ${flags}` : ''}`;
  const plain = `${prefix} -EncodedCommand ${Buffer.from(text, 'utf16le').toString('base64')}`;
  if (plain.length <= MAX_ENCODED_COMMAND_CHARS) return plain;
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
  const boot = "iex (New-Object IO.StreamReader((New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('"
    + gz + "'))),[IO.Compression.CompressionMode]::Decompress)),[Text.Encoding]::UTF8)).ReadToEnd()";
  const command = `${prefix} -Command "${boot}"`;
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`PowerShell script is too large to send to a Windows host (${command.length} characters after compression)`);
  }
  return command;
}

/** Build the remote command for the given probes (names are validated). */
function buildCommand(probes) {
  const list = probes.filter(p => PROBES.includes(p)).map(p => `'${p}'`).join(',');
  return execScript(`$Probes = @(${list})\n${SCRIPT}`, '-ExecutionPolicy Bypass');
}

/** Wrap an arbitrary PowerShell script for exec (custom commands, actions). */
function powershellCommand(script) {
  return execScript(script);
}

const jsonOf = t => {
  try { return JSON.parse(t); } catch { return null; }
};

const arr = v => (Array.isArray(v) ? v : v ? [v] : []);
const round1 = v => Math.round(v * 10) / 10;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const coreId = v => /^\d+$/.test(String(v)) ? Number(v) : v;

/** Convert raw Windows probe output into the Linux-style raw sections. */
function buildSnapshot(raw, prev, now = Date.now()) {
  /** @type {Record<string, any>} */
  const sections = {};
  /** @type {Record<string, number>} */
  const metrics = {};
  /** @type {Record<string, any>} */
  const state = { ...(prev || {}) };

  if (raw.stat !== undefined || raw.mem !== undefined) {
    const sys = (prev && prev.system) || {};
    const st = jsonOf(raw.stat || '') || {};
    const cpu = { model: sys.cpuModel || 'Unknown', coreCount: sys.cpuCores || 1, cores: [], threads: st.threads || sys.cpuThreads || 1,
      usagePercent: null, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, temperature: null };
    if (st.ts100ns) {
      if (prev && prev.stat && st.ts100ns > prev.stat.ts) {
        // PercentProcessorTime (raw) counts idle time in 100ns units.
        const idle = (st.busy100ns - prev.stat.busy) / (st.ts100ns - prev.stat.ts);
        cpu.usagePercent = round1(Math.max(0, Math.min(100, (1 - idle) * 100)));
        metrics['cpu.usage'] = cpu.usagePercent;
      }
      // Per-core usage from the same counters. Snapshot only: no per-core history is recorded.
      const before = new Map(((prev && prev.stat && prev.stat.cores) || []).map(c => [c.id, c]));
      cpu.cores = arr(st.cores).map(c => {
        const id = coreId(c.id);
        const p = before.get(id);
        if (!p || c.ts100ns <= p.ts100ns) return { id, usagePercent: null };
        const idle = (c.busy100ns - p.busy100ns) / (c.ts100ns - p.ts100ns);
        return { id, usagePercent: round1(Math.max(0, Math.min(100, (1 - idle) * 100))) };
      });
      state.stat = { busy: st.busy100ns, ts: st.ts100ns, cores: arr(st.cores).map(c => ({ id: coreId(c.id), busy100ns: c.busy100ns, ts100ns: c.ts100ns })) };
      state.uptimeSeconds = st.uptimeSeconds;
    }
    const m = jsonOf(raw.mem || '');
    let memory = null;
    if (m && m.totalKB) {
      const totalMB = Math.round(m.totalKB / 1024);
      const availableMB = Math.round(m.freeKB / 1024);
      const usedMB = totalMB - availableMB;
      const swapTotalMB = Math.round((m.pageTotalKB || 0) / 1024);
      memory = { totalMB, usedMB, freeMB: availableMB, availableMB, usagePercent: totalMB ? round1((usedMB / totalMB) * 100) : 0,
        swapTotalMB, swapUsedMB: swapTotalMB - Math.round((m.pageFreeKB || 0) / 1024), cachedMB: 0 };
      metrics['mem.used_pct'] = memory.usagePercent;
      metrics['mem.used_mb'] = memory.usedMB;
      state.memory = memory;
    }
    sections.cpu_memory = { cpu, memory: memory || (prev && prev.memory) || null, uptimeSeconds: state.uptimeSeconds ?? null };
  }

  if (raw.netdev !== undefined) {
    const t = now / 1000;
    const ifs = {};
    for (const i of arr(jsonOf(raw.netdev))) ifs[i.name] = { rx: i.rx, tx: i.tx };
    const rates = {};
    let rx = 0;
    let tx = 0;
    if (prev && prev.net && t > prev.net.t) {
      const dt = t - prev.net.t;
      for (const [name, c] of Object.entries(ifs)) {
        const p = prev.net.ifs[name];
        if (!p || c.rx < p.rx || c.tx < p.tx) continue;
        rates[name] = { rxBps: Math.round((c.rx - p.rx) / dt), txBps: Math.round((c.tx - p.tx) / dt) };
        if (!/loopback|isatap|teredo|vEthernet|virtual/i.test(name)) { rx += rates[name].rxBps; tx += rates[name].txBps; }
      }
      metrics['net.rx_bps'] = rx;
      metrics['net.tx_bps'] = tx;
    }
    state.net = { t, ifs };
    state.netRates = rates;
    sections.net_rates = { rates, rxBps: rx, txBps: tx };
  }

  if (raw.ip !== undefined) {
    // SSHCONN and DEFAULT lines, then a JSON list of physical adapters (connected or not).
    const lines = String(raw.ip).split('\n');
    const sshConn = (lines.find(l => l.startsWith('SSHCONN')) || '').replace(/^SSHCONN ?/, '');
    const defLine = lines.find(l => l.startsWith('DEFAULT'));
    const defaultIdx = defLine ? Number(defLine.replace(/^DEFAULT ?/, '')) : -1;
    const adapters = arr(jsonOf(lines.filter(l => !/^(SSHCONN|DEFAULT)/.test(l)).join('\n').trim()))
      .filter(a => !/bluetooth|virtual|hyper-v|vpn|tap-|miniport|loopback/i.test(`${a.name || ''} ${a.desc || ''}`));
    sections.network = adapters.map(a => ({
      name: a.name || a.desc, description: a.desc || '', state: a.up ? 'UP' : 'DOWN', mtu: null, macAddress: (a.mac || '').toLowerCase(),
      ipv4: arr(a.ips).filter(ip => ip.includes('.')), ipv6: arr(a.ips).filter(ip => ip.includes(':')),
      physical: true, wireless: /wi-?fi|wireless|wlan|802\.11/i.test(`${a.name || ''} ${a.desc || ''}`),
      default: Number.isFinite(defaultIdx) && defaultIdx >= 0 && a.idx === defaultIdx,
      rxBps: null, txBps: null,
    }));
    const main = sections.network.find(n => n.default)
      || sections.network.find(n => n.state === 'UP' && n.ipv4.length)
      || sections.network.find(n => n.ipv4.length);
    if (main) sections.network_headline = { name: main.name, ipv4: main.ipv4[0] ?? null, state: main.state, macAddress: main.macAddress };
    sections.nics = macs.pickMacs(sections.network.map(n => ({
      name: n.name, mac: n.macAddress, physical: true, wireless: n.wireless, up: n.state === 'UP', ipv4: n.ipv4,
    })), macs.serverIpFromSshConnection(sshConn));
  }

  if (raw.diskstats !== undefined) {
    const list = arr(jsonOf(raw.diskstats));
    const devices = {};
    for (const d of list) {
      if (!d || !d.name || d.name === '_Total') continue;
      devices[d.name] = { readBytes: num(d.read), writeBytes: num(d.write) };
    }
    const t = now / 1000;
    const rates = {};
    if (prev && prev.diskio && t > prev.diskio.t) {
      const dt = t - prev.diskio.t;
      for (const [name, c] of Object.entries(devices)) {
        const p = prev.diskio.devices[name];
        if (!p || c.readBytes < p.readBytes || c.writeBytes < p.writeBytes) continue; // new device or counter reset
        rates[name] = {
          readBps: Math.round((c.readBytes - p.readBytes) / dt),
          writeBps: Math.round((c.writeBytes - p.writeBytes) / dt),
        };
      }
      let readBps = 0;
      let writeBps = 0;
      for (const r of Object.values(rates)) { readBps += r.readBps; writeBps += r.writeBps; }
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
    const rates = state.diskRates || {};
    sections.disks = arr(jsonOf(raw.df)).filter(d => d.size > 0).map(d => {
      const sizeMB = Math.round(d.size / 1048576);
      const availableMB = Math.round(d.free / 1048576);
      const disk = { filesystem: d.label || d.id, fsType: d.fs, sizeMB, usedMB: sizeMB - availableMB, availableMB,
        usagePercent: sizeMB ? Math.round(((sizeMB - availableMB) / sizeMB) * 100) : 0, mountPoint: d.id };
      // A physical disk's name carries the drive letter ("0 C:"), which is enough to map it to the volume.
      const name = Object.keys(rates).find(n => d.id && n.includes(d.id));
      return name ? { ...disk, readBps: rates[name].readBps, writeBps: rates[name].writeBps } : disk;
    });
    const c = sections.disks.find(d => /^C:/i.test(d.mountPoint));
    if (c) metrics['disk.root_used_pct'] = c.usagePercent;
    if (sections.disks.length) metrics['disk.max_used_pct'] = Math.max(...sections.disks.map(d => d.usagePercent));
  }

  if (raw.services !== undefined) {
    sections.services = arr(jsonOf(raw.services)).map(s => ({
      name: s.name, description: s.display,
      status: /running/i.test(s.status) ? 'running' : 'stopped',
      enabled: !/disabled/i.test(s.start),
    }));
  }

  if (raw.system !== undefined) {
    const s = jsonOf(raw.system) || {};
    const sys = {
      name: 'Windows', id: 'windows', version: s.version || '', codename: s.build ? `build ${s.build}` : '',
      prettyName: s.caption || 'Windows', kernel: s.version || '', architecture: s.arch || '', hostname: s.host || '',
      cpuModel: (s.model || 'Unknown').trim(), cpuThreads: s.threads || 1, cpuCores: s.cores || s.threads || 1,
    };
    sections.system = sys;
    state.system = sys;
  }

  // GPU output is identical to Linux; reuse that parser.
  const shared = {};
  for (const k of ['gpu']) if (raw[k] !== undefined) shared[k] = raw[k];
  if (Object.keys(shared).length) {
    const r = linux.buildSnapshot(shared, null, now);
    Object.assign(sections, r.sections);
    Object.assign(metrics, r.metrics);
  }

  sections.metrics = metricsSection(withSlowMetrics(metrics, state), state.uptimeSeconds);
  return { sections, metrics, state };
}

/**
 * PowerShell run through -EncodedCommand reports its error and progress streams as CLIXML on
 * stderr ("#< CLIXML <Objs ...>"). Turn that into the plain text it represents, dropping progress records.
 */
function cleanPowerShellOutput(text) {
  const s = String(text || '');
  if (!s.includes('<Objs')) return s;
  const lines = [];
  for (const m of s.matchAll(/<S S="(?:Error|Output|Warning)">([\s\S]*?)<\/S>/g)) {
    lines.push(m[1].replace(/_x000D__x000A_/g, '\n').replace(/_x000D_/g, '').replace(/_x000A_/g, '\n')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  }
  const rest = s.replace(/#< CLIXML\s*/g, '').replace(/<Objs[\s\S]*?<\/Objs>/g, '').trim();
  return [rest, lines.join('').trim()].filter(Boolean).join('\n');
}

module.exports = { PROBES, SCRIPT, buildCommand, powershellCommand, execScript, cleanPowerShellOutput, splitSections, buildSnapshot };
