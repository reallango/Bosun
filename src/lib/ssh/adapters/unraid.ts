import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo } from './base';
import { CommandResult } from '../connection-pool';

export class UnraidAdapter extends BaseOSAdapter {
  async getOSInfo(): Promise<AdapterResult<OSInfo>> {
    // Unraid has /etc/unraid-version
    const result = await this.runCommand('cat /etc/unraid-version 2>/dev/null || cat /etc/os-release');
    if (result.exitCode !== 0) {
      return { data: this.getDefaultOSInfo(), error: result.stderr };
    }

    const lines = result.stdout.trim().split('\n');
    const version = lines[0] || '';

    return {
      data: {
        os_type: 'unraid',
        os_version: version,
        os_codename: '',
        kernel_version: '',
        hostname: ''
      }
    };
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    const result = await this.runCommand('lscpu | grep -E "Model name|CPU\\(s\\)" || cat /proc/cpuinfo | grep "model name" | head -1');
    if (result.exitCode !== 0) {
      return { data: { model: 'Unknown', cores: 1 } };
    }

    const lines = result.stdout.trim().split('\n');
    let model = 'Unknown';
    let cores = 1;

    for (const line of lines) {
      if (line.includes('model name')) {
        model = line.split(':')[1]?.trim() || 'Unknown';
      }
      if (line.includes('processor')) {
        cores++;
      }
    }

    return { data: { model, cores: Math.max(cores, 1) } };
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
      os_type: 'unraid',
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