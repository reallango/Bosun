import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo, ContainerInfo, ContainerStats } from './base';

export class UnraidAdapter extends BaseOSAdapter {
  async getOSInfo(): Promise<AdapterResult<OSInfo>> {
    try {
      const [version, kernel, hostname] = await Promise.all([
        this.runCommand('cat /etc/unraid-version 2>/dev/null'),
        this.runCommand('uname -r'),
        this.runCommand('hostname'),
      ]);
      return {
        data: {
          os_type: 'unraid',
          os_version: version.stdout.trim(),
          os_codename: '',
          kernel_version: kernel.stdout.trim(),
          hostname: hostname.stdout.trim(),
        }
      };
    } catch (error) {
      return { data: { os_type: 'unraid', os_version: '', os_codename: '', kernel_version: '', hostname: '' }, error: String(error) };
    }
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    try {
      const result = await this.runCommand('cat /proc/cpuinfo | grep "model name" | head -1');
      const model = result.stdout.includes('model name') ? result.stdout.split(':')[1]?.trim() || 'Unknown' : 'Unknown';
      const coresResult = await this.runCommand('nproc');
      const cores = parseInt(coresResult.stdout.trim(), 10) || 1;
      return { data: { model, cores } };
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
    return { data: [], error: 'Docker not available on Unraid' };
  }
  async startContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available on Unraid' };
  }
  async stopContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available on Unraid' };
  }
  async restartContainer(id: string): Promise<AdapterResult<boolean>> {
    return { data: false, error: 'Docker not available on Unraid' };
  }
  async getContainerLogs(id: string, tail = 100): Promise<AdapterResult<string>> {
    return { data: '', error: 'Docker not available on Unraid' };
  }
  async getContainerStats(id: string): Promise<AdapterResult<ContainerStats>> {
    return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 }, error: 'Docker not available on Unraid' };
  }
}