import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo } from './base';
import { CommandResult } from '../connection-pool';

export class DebianAdapter extends BaseOSAdapter {
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
        os_type: 'debian',
        os_version: info.VERSION_ID || '',
        os_codename: info.VERSION_CODENAME || '',
        kernel_version: '',
        hostname: info.HOSTNAME || ''
      }
    };
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    const result = await this.runCommand('lscpu | grep -E "Model name|CPU\\(s\\)"');
    if (result.exitCode !== 0) {
      return { data: { model: 'Unknown', cores: 1 } };
    }

    const lines = result.stdout.trim().split('\n');
    let model = 'Unknown';
    let cores = 1;

    for (const line of lines) {
      if (line.includes('Model name')) {
        model = line.split(':')[1]?.trim() || 'Unknown';
      }
      if (line.includes('CPU(s)')) {
        cores = parseInt(line.split(':')[1]?.trim() || '1', 10) || 1;
      }
    }

    return { data: { model, cores } };
  }

  async getMemoryInfo(): Promise<AdapterResult<MemoryInfo>> {
    const result = await this.runCommand("free -m | grep Mem:");
    if (result.exitCode !== 0) {
      return { data: { total_mb: 0 } };
    }

    const parts = result.stdout.trim().split(/\s+/);
    const total = parseInt(parts[1], 10) || 0;

    return { data: { total_mb: total } };
  }

  private getDefaultOSInfo(): OSInfo {
    return {
      os_type: 'debian',
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