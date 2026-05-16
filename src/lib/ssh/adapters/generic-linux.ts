import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo } from './base';
import { CommandResult } from '../connection-pool';

export class GenericLinuxAdapter extends BaseOSAdapter {
  async getOSInfo(): Promise<AdapterResult<OSInfo>> {
    const result = await this.runCommand('cat /etc/os-release');
    if (result.exitCode !== 0) {
      return { data: this.getDefaultOSInfo(), error: result.stderr };
    }

    const lines = result.stdout.split('\n');
    const info: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...value] = line.split('=');
      if (key && value.length) info[key] = value.join('=').replace(/"/g, '');
    }

    return {
      data: {
        os_type: 'generic',
        os_version: info.VERSION_ID || info.VERSION || '',
        os_codename: info.VERSION_CODENAME || '',
        kernel_version: '',
        hostname: info.HOSTNAME || ''
      }
    };
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    const result = await this.runCommand('lscpu 2>/dev/null || cat /proc/cpuinfo | head -20');
    if (result.exitCode !== 0) {
      return { data: { model: 'Unknown', cores: 1 } };
    }

    const lines = result.stdout.trim().split('\n');
    let model = 'Unknown';
    let cores = 1;

    for (const line of lines) {
      if (line.toLowerCase().includes('model name')) {
        model = line.split(':')[1]?.trim() || 'Unknown';
      }
      if (line.toLowerCase().includes('cpu(s)')) {
        cores = parseInt(line.split(':')[1]?.trim() || '1', 10) || 1;
      }
    }

    return { data: { model, cores } };
  }

  async getMemoryInfo(): Promise<AdapterResult<MemoryInfo>> {
    const result = await this.runCommand("cat /proc/meminfo | grep MemTotal");
    if (result.exitCode !== 0) {
      return { data: { total_mb: 0 } };
    }

    const kB = parseInt(result.stdout.split(':')[1]?.trim()?.replace(' kB', '') || '0', 10);
    const total = Math.round(kB / 1024);

    return { data: { total_mb: total } };
  }

  private getDefaultOSInfo(): OSInfo {
    return {
      os_type: 'generic',
      os_version: '',
      os_codename: '',
      kernel_version: '',
      hostname: ''
    };
  }

  protected async runCommand(cmd: string): Promise<CommandResult> {
    throw new Error('Not implemented');
  }
}