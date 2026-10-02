import { rqlite } from '../db/rqlite-client';
import { sshPool, SSHConnectionConfig } from './connection-pool';
import { isWindows, powershellCommand } from './platform';

export interface DetectedOs {
  os_type: string;
  os_version: string;
  os_codename: string;
  kernel_version: string;
  cpu_model: string;
  cpu_cores: number;
  total_ram_mb: number;
}

/**
 * Platform-aware OS/CPU/RAM detection.
 *
 * Extracted from the manual "Detect OS" route so the health checker can also
 * call it (once, when a server's os_type is still NULL) and newly added servers
 * self-populate instead of showing "Unknown OS" until someone clicks Detect.
 * Performs the servers UPDATE itself and returns the detected fields; callers
 * that need it add their own audit logging.
 */
export async function detectServerOs(
  serverId: string,
  server: { platform?: string | null },
  sshConfig: SSHConnectionConfig
): Promise<DetectedOs> {
  const run = async (cmd: string) => sshPool.executeCommand(serverId, sshConfig, cmd);

  if (isWindows(server)) {
    const runPS = async (script: string) => sshPool.executeCommand(serverId, sshConfig, powershellCommand(script));
    const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $os = Get-CimInstance Win32_OperatingSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; [pscustomobject]@{ caption=$os.Caption; version=$os.Version; arch=$os.OSArchitecture; cpu=$cpu.Name; cores=[int]$cpu.NumberOfCores; ramMB=[math]::Round([double]$os.TotalVisibleMemorySize/1024) } | ConvertTo-Json -Compress";
    const r = await runPS(script);
    let d: any = {};
    try { d = JSON.parse(r.stdout.trim()); } catch {}
    const result: DetectedOs = {
      os_type: 'windows',
      os_version: d.version || '',
      os_codename: '',
      kernel_version: d.version || '',
      cpu_model: d.cpu || 'Unknown',
      cpu_cores: d.cores || 1,
      total_ram_mb: d.ramMB || 0,
    };
    await rqlite.execute("UPDATE servers SET platform='windows',os_type=?,os_version=?,os_codename=?,kernel_version=?,cpu_model=?,cpu_cores=?,total_ram_mb=?,is_online=1,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [result.os_type, result.os_version, result.os_codename, result.kernel_version, result.cpu_model, result.cpu_cores, result.total_ram_mb, serverId]);
    return result;
  }

  const unraid = await run('cat /etc/unraid-version 2>/dev/null');
  let osType = 'generic', osVer = '', osCn = '';
  if (unraid.exitCode === 0 && unraid.stdout.trim()) {
    osType = 'unraid'; osVer = unraid.stdout.match(/version="?([^"\n]+)"?/)?.[1] || '';
  } else {
    const osr = await run('cat /etc/os-release');
    const p: Record<string, string> = {};
    osr.stdout.split('\n').forEach(l => { const [k, ...v] = l.split('='); if (k && v.length) p[k.trim()] = v.join('=').replace(/"/g, '').trim(); });
    const id = (p['ID'] || '').toLowerCase();
    osType = ['ubuntu', 'pop', 'linuxmint'].includes(id) ? 'ubuntu' : ['debian', 'raspbian'].includes(id) ? 'debian' : id || 'generic';
    osVer = p['VERSION_ID'] || ''; osCn = p['VERSION_CODENAME'] || '';
  }
  const [kern, cpu, mem] = await Promise.all([run('uname -r'), run('lscpu 2>/dev/null||cat /proc/cpuinfo|head -20'), run('cat /proc/meminfo')]);
  let cpuModel = 'Unknown', cores = 1;
  cpu.stdout.split('\n').forEach(l => { if (l.startsWith('Model name:')) cpuModel = l.split(':')[1]?.trim() || cpuModel; if (l.startsWith('CPU(s):')) cores = parseInt(l.split(':')[1]?.trim() || '1', 10); });
  const mm = mem.stdout.match(/MemTotal:\s+(\d+)/);
  const ram = mm ? Math.round(parseInt(mm[1], 10) / 1024) : 0;
  const result: DetectedOs = {
    os_type: osType,
    os_version: osVer,
    os_codename: osCn,
    kernel_version: kern.stdout.trim(),
    cpu_model: cpuModel,
    cpu_cores: cores,
    total_ram_mb: ram,
  };
  await rqlite.execute("UPDATE servers SET os_type=?,os_version=?,os_codename=?,kernel_version=?,cpu_model=?,cpu_cores=?,total_ram_mb=?,is_online=1,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [result.os_type, result.os_version, result.os_codename, result.kernel_version, result.cpu_model, result.cpu_cores, result.total_ram_mb, serverId]);
  return result;
}
