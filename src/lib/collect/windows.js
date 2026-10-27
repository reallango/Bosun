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

const linux = require('./linux');
const { splitSections } = linux;

const PROBES = ['stat', 'mem', 'netdev', 'gpu', 'df', 'ip', 'docker', 'ollama', 'services', 'system'];

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
function M($n) { Write-Output ("@@BOSUN " + $n) }
function J($o) { Write-Output ($o | ConvertTo-Json -Compress -Depth 4) }
foreach ($p in $Probes) {
  switch ($p) {
    'stat' { M 'stat'
      $c = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'"
      $os = Get-CimInstance Win32_OperatingSystem
      J @{ busy100ns = [double]$c.PercentProcessorTime; ts100ns = [double]$c.Timestamp_Sys100NS; threads = [Environment]::ProcessorCount;
           uptimeSeconds = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } }
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
    'df' { M 'df'
      J @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ id = $_.DeviceID; fs = $_.FileSystem; size = [double]$_.Size; free = [double]$_.FreeSpace; label = $_.VolumeName } }) }
    'ip' { M 'ip'
      J @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object { @{ name = $_.Description; mac = $_.MACAddress; ips = @($_.IPAddress) } }) }
    'docker' { M 'docker'
      $d = Get-Command docker.exe -ErrorAction SilentlyContinue
      if ($d) { $out = & $d.Source ps -a --no-trunc --format '{{json .}}' 2>&1; Write-Output ("RC " + $LASTEXITCODE); $out | Select-Object -First 500 }
      else { Write-Output 'NONE' } }
    'ollama' { M 'ollama'
      try {
        $v = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/version
        Write-Output $v.Content
        Write-Output (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:11434/api/tags).Content
        Write-Output (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/ps).Content
      } catch { Write-Output 'DOWN' } }
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

/** Build the remote command for the given probes (names are validated). */
function buildCommand(probes) {
  const list = probes.filter(p => PROBES.includes(p)).map(p => `'${p}'`).join(',');
  const script = `$Probes = @(${list})\n${SCRIPT}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** Wrap an arbitrary PowerShell script for exec (custom commands, actions). */
function powershellCommand(script) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(String(script), 'utf16le').toString('base64')}`;
}

const jsonOf = t => {
  try { return JSON.parse(t); } catch { return null; }
};
const arr = v => (Array.isArray(v) ? v : v ? [v] : []);
const round1 = v => Math.round(v * 10) / 10;

/** Convert raw Windows probe output into the Linux-style raw sections. */
function buildSnapshot(raw, prev, now = Date.now()) {
  const sections = {};
  const metrics = {};
  const state = { ...(prev || {}) };

  if (raw.stat !== undefined || raw.mem !== undefined) {
    const sys = (prev && prev.system) || {};
    const st = jsonOf(raw.stat || '') || {};
    const cpu = { model: sys.cpuModel || 'Unknown', cores: sys.cpuCores || 1, threads: st.threads || sys.cpuThreads || 1,
      usagePercent: null, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, temperature: null };
    if (st.ts100ns) {
      if (prev && prev.stat && st.ts100ns > prev.stat.ts) {
        // PercentProcessorTime (raw) counts idle time in 100ns units.
        const idle = (st.busy100ns - prev.stat.busy) / (st.ts100ns - prev.stat.ts);
        cpu.usagePercent = round1(Math.max(0, Math.min(100, (1 - idle) * 100)));
        metrics['cpu.usage'] = cpu.usagePercent;
      }
      state.stat = { busy: st.busy100ns, ts: st.ts100ns };
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
    sections.network = arr(jsonOf(raw.ip)).map(a => ({
      name: a.name, state: 'UP', mtu: null, macAddress: a.mac || '',
      ipv4: arr(a.ips).filter(ip => ip.includes('.')), ipv6: arr(a.ips).filter(ip => ip.includes(':')),
      rxBps: null, txBps: null,
    }));
  }

  if (raw.df !== undefined) {
    sections.disks = arr(jsonOf(raw.df)).filter(d => d.size > 0).map(d => {
      const sizeMB = Math.round(d.size / 1048576);
      const availableMB = Math.round(d.free / 1048576);
      return { filesystem: d.label || d.id, fsType: d.fs, sizeMB, usedMB: sizeMB - availableMB, availableMB,
        usagePercent: sizeMB ? Math.round(((sizeMB - availableMB) / sizeMB) * 100) : 0, mountPoint: d.id };
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

  // GPU, docker and ollama output is identical to Linux; reuse those parsers.
  const shared = {};
  for (const k of ['gpu', 'docker', 'ollama']) if (raw[k] !== undefined) shared[k] = raw[k];
  if (Object.keys(shared).length) {
    const r = linux.buildSnapshot(shared, null, now);
    Object.assign(sections, r.sections);
    Object.assign(metrics, r.metrics);
  }

  return { sections, metrics, state };
}

module.exports = { PROBES, SCRIPT, buildCommand, powershellCommand, splitSections, buildSnapshot };
