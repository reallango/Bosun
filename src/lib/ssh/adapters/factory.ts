import { BaseOSAdapter, OSInfo, CPUInfo, MemoryInfo } from './base';
import { SSHConnectionPool, SSHConnectionConfig, CommandResult } from '../connection-pool';
import { UbuntuAdapter } from './ubuntu';
import { DebianAdapter } from './debian';
import { UnraidAdapter } from './unraid';
import { GenericLinuxAdapter } from './generic-linux';

export interface Server {
  id: string;
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string | null;
  os_type: string | null;
  os_version: string | null;
  os_codename: string | null;
}

export interface DetectResult {
  os_type: string;
  os_version: string;
  os_codename: string;
  kernel_version: string;
  cpu_model: string;
  cpu_cores: number;
  total_ram_mb: number;
}

export async function runCommandOnServer(
  pool: SSHConnectionPool,
  server: Server,
  privateKey: string,
  command: string
): Promise<CommandResult> {
  const sshConfig: SSHConnectionConfig = {
    host: server.hostname,
    port: server.ssh_port || 22,
    username: server.ssh_user,
    privateKey
  };

  return pool.executeCommand(server.id, sshConfig, command);
}

class AdapterFactory {
  static async detectOS(
    pool: SSHConnectionPool,
    server: Server,
    privateKey: string
  ): Promise<DetectResult> {
    const sshConfig: SSHConnectionConfig = {
      host: server.hostname,
      port: server.ssh_port || 22,
      username: server.ssh_user,
      privateKey
    };

    // Create a runner function for adapters
    const runCommand = async (cmd: string): Promise<CommandResult> => {
      return pool.executeCommand(server.id, sshConfig, cmd);
    };

    // Get OS info first to determine adapter type
    const osResult = await runCommand('cat /etc/os-release');
    let osType = 'generic';

    if (osResult.exitCode === 0) {
      const lines = osResult.stdout.split('\n');
      const info: Record<string, string> = {};
      for (const line of lines) {
        const [key, ...value] = line.split('=');
        if (key && value.length) info[key] = value.join('=').replace(/"/g, '');
      }

      const id = info.ID?.toLowerCase() || '';
      if (id.includes('ubuntu') || id.includes('pop') || id.includes('mint')) {
        osType = 'ubuntu';
      } else if (id.includes('debian') || id.includes('raspbian')) {
        osType = 'debian';
      } else if (id.includes('unraid')) {
        osType = 'unraid';
      }
    }

    // Check for Unraid special file
    if (osType === 'generic') {
      const unraidCheck = await runCommand('test -f /etc/unraid-version && cat /etc/unraid-version');
      if (unraidCheck.exitCode === 0 && unraidCheck.stdout.trim()) {
        osType = 'unraid';
      }
    }

    // Get CPU and memory info
    const cpuResult = await runCommand('lscpu 2>/dev/null || cat /proc/cpuinfo | head -20');
    let cpuModel = 'Unknown';
    let cpuCores = 1;

    if (cpuResult.exitCode === 0) {
      const lines = cpuResult.stdout.trim().split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes('model name')) {
          cpuModel = line.split(':')[1]?.trim() || 'Unknown';
        }
        if (line.toLowerCase().includes('cpu(s)')) {
          cpuCores = parseInt(line.split(':')[1]?.trim() || '1', 10) || 1;
        }
      }
    }

    const memResult = await runCommand("cat /proc/meminfo | grep MemTotal");
    let totalRamMb = 0;

    if (memResult.exitCode === 0) {
      const kB = parseInt(memResult.stdout.split(':')[1]?.trim()?.replace(' kB', '') || '0', 10);
      totalRamMb = Math.round(kB / 1024);
    }

    const osReleaseResult = await runCommand('cat /etc/os-release');
    let osVersion = '';
    let osCodename = '';

    if (osReleaseResult.exitCode === 0) {
      const lines = osReleaseResult.stdout.split('\n');
      const info: Record<string, string> = {};
      for (const line of lines) {
        const [key, ...value] = line.split('=');
        if (key && value.length) info[key] = value.join('=').replace(/"/g, '');
      }
      osVersion = info.VERSION_ID || info.VERSION || '';
      osCodename = info.VERSION_CODENAME || '';
    }

    return {
      os_type: osType,
      os_version: osVersion,
      os_codename: osCodename,
      kernel_version: '',
      cpu_model: cpuModel,
      cpu_cores: cpuCores,
      total_ram_mb: totalRamMb
    };
  }
}

export { AdapterFactory };

export async function getAdapter(serverId: string) {
  const { rqlite } = await import('@/lib/db/rqlite-client');
  const { SSHConnectionPool } = await import('../connection-pool');
  const { decrypt } = await import('../../crypto/keys');
  
  const serverResult = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!serverResult.values.length) return null;
  const row = serverResult.values[0];
  const server = {
    id: row[0] as string, hostname: row[3] as string, ssh_port: row[4] as number,
    ssh_user: row[5] as string, ssh_key_id: row[6] as string | null
  };
  
  if (!server.ssh_key_id) return null;
  
  const keyResult = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id = ?', [server.ssh_key_id]);
  if (!keyResult.values.length) return null;
  
  const masterKey = process.env.MASTER_KEY;
  if (!masterKey) return null;
  
  const privateKey = decrypt(keyResult.values[0][0] as string, masterKey);
  if (!privateKey) return null;
  
  const pool = new SSHConnectionPool();
  const sshConfig = {
    host: server.hostname,
    port: server.ssh_port || 22,
    username: server.ssh_user,
    privateKey
  };
  
  const runCommand = async (cmd: string) => pool.executeCommand(server.id, sshConfig, cmd);
  
  const osResult = await runCommand('cat /etc/os-release');
  let osType = 'generic';
  if (osResult.exitCode === 0) {
    const lines = osResult.stdout.split('\n');
    const info: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...value] = line.split('=');
      if (key && value.length) info[key] = value.join('=').replace(/"/g, '');
    }
    const id = info.ID?.toLowerCase() || '';
    if (id.includes('ubuntu') || id.includes('pop') || id.includes('mint')) osType = 'ubuntu';
    else if (id.includes('debian') || id.includes('raspbian')) osType = 'debian';
    else if (id.includes('unraid')) osType = 'unraid';
  }
  
  const { UbuntuAdapter } = await import('./ubuntu');
  const { DebianAdapter } = await import('./debian');
  
  switch (osType) {
    case 'ubuntu': return new UbuntuAdapter(runCommand);
    case 'debian': return new DebianAdapter(runCommand);
    case 'unraid':
      const { UnraidAdapter } = await import('./unraid');
      return new UnraidAdapter(runCommand);
    default:
      const { GenericLinuxAdapter } = await import('./generic-linux');
      return new GenericLinuxAdapter(runCommand);
  }
}