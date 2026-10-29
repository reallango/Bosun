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
const { metricsSection } = require('./metrics-section');
const { splitSections } = linux;

const PROBES = ['stat', 'mem', 'netdev', 'gpu', 'df', 'ip', 'docker', 'ollama', 'services', 'system', 'updates'];

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
      Write-Output ("SSHCONN " + $env:SSH_CONNECTION)
      $cfgs = @{}; Get-CimInstance Win32_NetworkAdapterConfiguration | ForEach-Object { $cfgs[[int]$_.Index] = $_ }
      J @(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' | Where-Object { $_.MACAddress } | ForEach-Object {
        $c = $cfgs[[int]$_.Index]
        @{ name = $_.NetConnectionID; desc = $_.Name; mac = $_.MACAddress; up = ($_.NetConnectionStatus -eq 2); ips = @(if ($c -and $c.IPAddress) { $c.IPAddress }) } }) }
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
      } catch { Write-Output 'DOWN' }
      Write-Output '@@INSTALL'
      $s = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq 'Ollama' -or $_.Name -like '*ollama*' } | Sort-Object { if ($_.Name -eq 'Ollama') { 0 } else { 1 } } | Select-Object -First 1
      if ($s) {
        Write-Output ('SVC_NAME=' + $s.Name)
        Write-Output ('SVC_STATE=' + $s.State)
        Write-Output ('SVC_START=' + $s.StartMode)
        Write-Output ('SVC_DELAYED=' + $s.DelayedAutoStart)
        $exe = ($s.PathName -replace '^"?([^"]+?)"?(\s.*)?$', '$1')
        if ($s.PathName -match 'nssm') {
          Write-Output 'SVC_WRAPPER=nssm'
          $app = (Get-ItemProperty ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $s.Name + '\Parameters') -ErrorAction SilentlyContinue).Application
          if ($app) { $exe = $app }
        }
        Write-Output ('SVC_EXE=' + $exe)
        # The settings Bosun manages: nssm keeps them in AppEnvironmentExtra, a plain service in its Environment value.
        $envKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $s.Name
        if ($s.PathName -match 'nssm') { $envList = @((Get-ItemProperty ($envKey + '\Parameters') -ErrorAction SilentlyContinue).AppEnvironmentExtra) }
        else { $envList = @((Get-ItemProperty $envKey -ErrorAction SilentlyContinue).Environment) }
        foreach ($e in $envList) { if ($e -match '^(OLLAMA_CONTEXT_LENGTH|OLLAMA_MAX_LOADED_MODELS)=') { Write-Output ('ENV_' + $e) } }
      } else {
        $p = Get-Process -Name ollama -ErrorAction SilentlyContinue | Select-Object -First 1
        $std = Get-ChildItem 'C:\Users\*\AppData\Local\Programs\Ollama\ollama.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and $p.Path) { Write-Output ('STANDARD_PATH=' + $p.Path) } elseif ($std) { Write-Output ('STANDARD_PATH=' + $std.FullName) }
      } }
    'services' { M 'services'
      J @(Get-Service | Select-Object -First 400 | ForEach-Object { @{ name = $_.Name; status = [string]$_.Status; display = $_.DisplayName; start = [string]$_.StartType } }) }
    'system' { M 'system'
      $os = Get-CimInstance Win32_OperatingSystem; $cpu = @(Get-CimInstance Win32_Processor)
      J @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture; host = $env:COMPUTERNAME;
           model = $cpu[0].Name; cores = ($cpu | Measure-Object NumberOfCores -Sum).Sum; threads = ($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum } }
    'updates' { M 'updates'
      # Windows Update search (read-only). Slow (15 s to minutes): the poller runs it on its own, never with the regular probes.
      # "Reboot pending" comes from the registry markers Windows Update and servicing set. The COM class for it
      # (Microsoft.Update.SystemInfo) is refused for a remote (SSH) session, and must never cost the update list.
      $reboot = $false
      try {
        $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
      } catch { $reboot = $false }
      try {
        $ErrorActionPreference = 'Stop'
        $wu =(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
        $list = @(foreach ($u in $wu.Updates) {
          $cats = @(foreach ($c in $u.Categories) { $c.Name })
          $kbs = @(foreach ($k in $u.KBArticleIDs) { "KB$k" })
          @{ title = [string]$u.Title; kb = ($kbs -join ','); severity = [string]$u.MsrcSeverity; categories = ($cats -join ';'); mb = [math]::Round($u.MaxDownloadSize / 1MB, 1) }
        })
        J @{ ok = $true; rebootRequired = [bool]$reboot; updates = $list }
      } catch { J @{ ok = $false; error = [string]$_.Exception.Message } }
      $ErrorActionPreference = 'SilentlyContinue' }
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

/**
 * Windows Update search result -> the `updates` section the OS Update widget reads
 * (same shape the Linux package managers produce). A failed or unreadable search
 * is reported in `error` so the widget can say why instead of showing "up to date".
 */
function parseUpdates(u) {
  const base = { manager: 'windows', updatesAvailable: 0, securityUpdates: 0, rebootRequired: false, packages: [] };
  if (!u || u.ok === false || !Array.isArray(u.updates)) {
    return { ...base, error: String((u && u.error) || 'Windows Update returned no data').slice(0, 300) };
  }
  // Anything Microsoft rates (MSRC severity) or files under "Security Updates" counts as security.
  const packages = u.updates.map(p => ({
    name: p.title || p.kb || 'Update',
    current_version: '',
    // Most titles already end in "(KB1234567)"; only show the KB separately when the title lacks it.
    new_version: p.kb && !String(p.title || '').includes(p.kb) ? p.kb : '',
    is_security: /security/i.test(p.categories || '') || !!p.severity,
  }));
  return {
    ...base,
    updatesAvailable: packages.length,
    securityUpdates: packages.filter(p => p.is_security).length,
    rebootRequired: !!u.rebootRequired,
    packages: packages.slice(0, 200),
  };
}
const arr = v => (Array.isArray(v) ? v : v ? [v] : []);
const round1 = v => Math.round(v * 10) / 10;

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
    // SSHCONN line, then a JSON list of physical adapters (connected or not).
    const lines = String(raw.ip).split('\n');
    const sshConn = (lines.find(l => l.startsWith('SSHCONN')) || '').replace(/^SSHCONN ?/, '');
    const adapters = arr(jsonOf(lines.filter(l => !l.startsWith('SSHCONN')).join('\n').trim()))
      .filter(a => !/bluetooth|virtual|hyper-v|vpn|tap-|miniport|loopback/i.test(`${a.name || ''} ${a.desc || ''}`));
    sections.network = adapters.map(a => ({
      name: a.name || a.desc, description: a.desc || '', state: a.up ? 'UP' : 'DOWN', mtu: null, macAddress: (a.mac || '').toLowerCase(),
      ipv4: arr(a.ips).filter(ip => ip.includes('.')), ipv6: arr(a.ips).filter(ip => ip.includes(':')),
      physical: true, wireless: /wi-?fi|wireless|wlan|802\.11/i.test(`${a.name || ''} ${a.desc || ''}`),
      rxBps: null, txBps: null,
    }));
    sections.nics = macs.pickMacs(sections.network.map(n => ({
      name: n.name, mac: n.macAddress, physical: true, wireless: n.wireless, up: n.state === 'UP', ipv4: n.ipv4,
    })), macs.serverIpFromSshConnection(sshConn));
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

  if (raw.updates !== undefined) {
    sections.updates = parseUpdates(jsonOf(raw.updates));
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

  sections.metrics = metricsSection(metrics, state.uptimeSeconds);
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
