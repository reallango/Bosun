'use strict';

/**
 * Shared Windows widget data collectors.
 *
 * Dependency-free CommonJS so the Next.js widget route (TypeScript) and the
 * root poller.js can share one implementation. `runPS(script)` executes the
 * given PowerShell script on the host and resolves to
 * { stdout, stderr, exitCode }; the caller is responsible for wrapping the
 * script with `powershellCommand` (exported below) so quoting lives in exactly
 * one place.
 *
 * Collectors emit compact JSON from PowerShell and parse it here, returning the
 * same JSON shapes the Linux collectors produce so the React widgets are
 * platform-agnostic.
 */

/**
 * Wrap a PowerShell script for non-interactive execution over SSH.
 *
 * The script is UTF-16LE Base64 encoded and passed via `-EncodedCommand` rather
 * than as a double-quoted `-Command` argument. A Windows host whose default SSH
 * shell is PowerShell launches `powershell.exe -c '<command>'`, so an outer
 * PowerShell parses the command first and would interpolate `$vars` inside the
 * double-quoted script, stripping them before the inner powershell.exe runs.
 * The encoded form is opaque to cmd.exe and to any outer PowerShell, so `$`,
 * quotes, `%` and newlines reach the host verbatim.
 */
function powershellCommand(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Prefix a script so powershell.exe emits UTF-8 rather than the console's
 * default code page, keeping non-ASCII output intact over the SSH channel.
 */
function ps(script) {
  return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + script;
}

function parseJson(out) {
  let s = (out || '').trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function getWindowsWidgetData(type, runPS, cfg = {}) {
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
      const script = ps(`
$os = Get-CimInstance Win32_OperatingSystem
$up = (Get-Date) - $os.LastBootUpTime
[pscustomobject]@{
  name = $os.Caption
  version = $os.Version
  codename = ''
  prettyName = $os.Caption
  kernel = $os.Version
  architecture = $os.OSArchitecture
  hostname = $env:COMPUTERNAME
  uptime = ('{0}d {1}h {2}m' -f [int]$up.TotalDays, $up.Hours, $up.Minutes)
  uptimeSeconds = [int]$up.TotalSeconds
} | ConvertTo-Json -Compress`);
      const r = await runPS(script);
      const d = parseJson(r.stdout);
      if (!d) return { name: 'Windows', version: '', codename: '', prettyName: 'Windows', kernel: '', architecture: '', hostname: '', uptime: '-', uptimeSeconds: 0 };
      return d;
    }

    case 'cpu_memory': {
      const script = ps(`
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$totalKB = [double]$os.TotalVisibleMemorySize
$freeKB = [double]$os.FreePhysicalMemory
$usedKB = $totalKB - $freeKB
$cpuPct = 0
try { $cpuPct = [math]::Round((Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue, 1) } catch {}
$totalMB = [math]::Round($totalKB / 1024)
$usedMB = [math]::Round($usedKB / 1024)
$freeMB = [math]::Round($freeKB / 1024)
$memPct = if ($totalMB -gt 0) { [math]::Round(($usedMB / $totalMB) * 1000) / 10 } else { 0 }
[pscustomobject]@{
  cpu = [pscustomobject]@{
    model = $cpu.Name
    cores = [int]$cpu.NumberOfCores
    threads = [int]$cpu.NumberOfLogicalProcessors
    usagePercent = $cpuPct
    loadAvg1 = $null
    loadAvg5 = $null
    loadAvg15 = $null
    temperature = $null
  }
  memory = [pscustomobject]@{
    totalMB = $totalMB
    usedMB = $usedMB
    freeMB = $freeMB
    availableMB = $freeMB
    usagePercent = $memPct
    swapTotalMB = 0
    swapUsedMB = 0
  }
} | ConvertTo-Json -Compress -Depth 4`);
      const r = await runPS(script);
      const d = parseJson(r.stdout);
      if (!d) {
        return {
          cpu: { model: 'Unknown', cores: 0, threads: 0, usagePercent: 0, loadAvg1: null, loadAvg5: null, loadAvg15: null, temperature: null },
          memory: { totalMB: 0, usedMB: 0, freeMB: 0, availableMB: 0, usagePercent: 0, swapTotalMB: 0, swapUsedMB: 0 },
        };
      }
      return d;
    }

    case 'disk_usage': {
      const script = ps(`
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $size = $_.Size; $free = $_.FreeSpace; $used = $size - $free
  $pct = if ($size -gt 0) { [int][math]::Round(($used / $size) * 100) } else { 0 }
  [pscustomobject]@{
    filesystem = $_.DeviceID
    fsType = $_.FileSystem
    sizeMB = [math]::Round($size / 1MB)
    usedMB = [math]::Round($used / 1MB)
    availableMB = [math]::Round($free / 1MB)
    usagePercent = $pct
    mountPoint = $_.DeviceID
  }
} | ConvertTo-Json -Compress`);
      const r = await runPS(script);
      return toArray(parseJson(r.stdout));
    }

    case 'network': {
      const script = ps(`
Get-NetAdapter | Where-Object { $_.InterfaceAlias -notlike 'Loopback*' } | ForEach-Object {
  $ips = @(Get-NetIPAddress -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue)
  [pscustomobject]@{
    name = $_.Name
    state = if ($_.Status -eq 'Up') { 'UP' } else { 'DOWN' }
    mtu = $_.MtuSize
    macAddress = $_.MacAddress
    ipv4 = @($ips | Where-Object { $_.AddressFamily -eq 'IPv4' } | ForEach-Object { $_.IPAddress })
    ipv6 = @($ips | Where-Object { $_.AddressFamily -eq 'IPv6' } | ForEach-Object { $_.IPAddress })
  }
} | ConvertTo-Json -Compress -Depth 4`);
      const r = await runPS(script);
      return toArray(parseJson(r.stdout)).map(i => ({
        name: i.name,
        state: i.state,
        mtu: i.mtu,
        macAddress: i.macAddress || '',
        ipv4: toArray(i.ipv4),
        ipv6: toArray(i.ipv6),
      }));
    }

    case 'system_services': {
      const where = (cfg.filter || 'running') === 'running'
        ? "Get-Service | Where-Object { $_.Status -eq 'Running' }"
        : 'Get-Service';
      const script = ps(`
${where} | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    status = if ($_.Status -eq 'Running') { 'running' } else { 'stopped' }
    description = $_.DisplayName
    enabled = ($_.StartType -eq 'Automatic')
  }
} | ConvertTo-Json -Compress`);
      const r = await runPS(script);
      return toArray(parseJson(r.stdout));
    }

    case 'gpu_monitoring': {
      const r = await runPS('nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader 2>$null');
      if (r.exitCode === 0 && r.stdout.trim()) {
        const parts = r.stdout.trim().split(/\r?\n/)[0].split(',').map(p => p.trim());
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
      const r = await runPS(ps(`
try { Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 5 | ConvertTo-Json -Compress -Depth 6 } catch {}`));
      const tags = parseJson(r.stdout);
      if (!tags) return { status: 'stopped', models: [] };
      return { status: 'running', models: tags.models || [] };
    }

    case 'custom_command': {
      const cmd = cfg.command || 'Get-Date';
      const r = await runPS(cmd);
      return { output: r.stdout + r.stderr, exitCode: r.exitCode };
    }

    // Not supported on Windows in v1 - return the graceful placeholder rather
    // than an error so the widget renders without a red error box.
    case 'docker_containers':
      return [];
    case 'os_update_check':
      return { source: 'placeholder' };

    default:
      return undefined;
  }
}

module.exports = { getWindowsWidgetData, powershellCommand };
