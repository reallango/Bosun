import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo, ContainerInfo, ContainerStats } from './base';

export class GenericLinuxAdapter extends BaseOSAdapter {
  async getOSInfo(): Promise<AdapterResult<OSInfo>> {
    try {
      const [osRelease, kernel, hostname] = await Promise.all([
        this.runCommand('cat /etc/os-release'),
        this.runCommand('uname -r'),
        this.runCommand('hostname'),
      ]);
      const parsed: Record<string, string> = {};
      osRelease.stdout.split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length) parsed[key.trim()] = rest.join('=').replace(/"/g, '').trim();
      });
      return {
        data: {
          os_type: 'generic',
          os_version: parsed['VERSION_ID'] || parsed['VERSION'] || '',
          os_codename: parsed['VERSION_CODENAME'] || '',
          kernel_version: kernel.stdout.trim(),
          hostname: hostname.stdout.trim(),
        }
      };
    } catch (error) {
      return { data: { os_type: 'generic', os_version: '', os_codename: '', kernel_version: '', hostname: '' }, error: String(error) };
    }
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    try {
      const result = await this.runCommand('cat /proc/cpuinfo | head -20');
      let model = 'Unknown';
      let cores = 1;
      result.stdout.split('\n').forEach(line => {
        if (line.toLowerCase().includes('model name')) model = line.split(':')[1]?.trim() || model;
        if (line.toLowerCase().includes('processor')) cores++;
      });
      return { data: { model, cores: Math.max(cores, 1) } };
    } catch (error) {
      return { data: { model: 'Unknown', cores: 1 }, error: String(error) };
    }
  }

  async getMemoryInfo(): Promise<AdapterResult<MemoryInfo>> {
    try {
      const result = await this.runCommand('cat /proc/meminfo');
      const match = result.stdout.match(/MemTotal:\s+(\d+)/);
      return { data: { total_mb: Math.round((match ? parseInt(match[1], 10) : 0) / 1024) } };
    } catch (error) {
      return { data: { total_mb: 0 }, error: String(error) };
    }
  }

  async listContainers(): Promise<AdapterResult<ContainerInfo[]>> {
    return { data: [], error: 'Docker not available' };
  }
  async startContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available' };
  }
  async stopContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available' };
  }
  async restartContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available' };
  }
  async getContainerLogs(id: string, tail = 100): Promise<AdapterResult<string>> {
    return { data: '', error: 'Docker not available' };
  }
  async getContainerStats(id: string): Promise<AdapterResult<ContainerStats>> {
    return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 }, error: 'Docker not available' };
  }
}