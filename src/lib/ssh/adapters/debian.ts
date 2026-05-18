import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo, ContainerInfo, ContainerStats } from './base';

export class DebianAdapter extends BaseOSAdapter {
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
        if (key && rest.length) {
          parsed[key.trim()] = rest.join('=').replace(/"/g, '').trim();
        }
      });

      return {
        data: {
          os_type: 'debian',
          os_version: parsed['VERSION_ID'] || '',
          os_codename: parsed['VERSION_CODENAME'] || '',
          kernel_version: kernel.stdout.trim(),
          hostname: hostname.stdout.trim(),
        }
      };
    } catch (error) {
      return { data: { os_type: 'debian', os_version: '', os_codename: '', kernel_version: '', hostname: '' }, error: String(error) };
    }
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    try {
      const result = await this.runCommand('lscpu');
      const lines = result.stdout.split('\n');
      let model = 'Unknown';
      let cores = 1;
      for (const line of lines) {
        if (line.startsWith('Model name:')) model = line.split(':')[1]?.trim() || model;
        if (line.startsWith('CPU(s):')) cores = parseInt(line.split(':')[1]?.trim() || '1', 10);
      }
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

  // Docker methods (same as Ubuntu)
  async listContainers(): Promise<AdapterResult<ContainerInfo[]>> {
    try {
      const result = await this.runCommand('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.CreatedAt}}|{{.Ports}}"');
      if (!result.stdout.trim()) return { data: [] };
      const containers = result.stdout.trim().split('\n').map(line => {
        const [id, name, image, status, state, created, ports] = line.split('|');
        return { id, name, image, status, state, created, ports };
      });
      return { data: containers };
    } catch (error) {
      return { data: [], error: String(error) };
    }
  }
  async startContainer(id: string): Promise<AdapterResult<boolean>> {
    try { await this.runCommand(`docker start ${id}`); return { data: true }; }
    catch (error) { return { data: false, error: String(error) }; }
  }
  async stopContainer(id: string): Promise<AdapterResult<boolean>> {
    try { await this.runCommand(`docker stop ${id}`); return { data: true }; }
    catch (error) { return { data: false, error: String(error) }; }
  }
  async restartContainer(id: string): Promise<AdapterResult<boolean>> {
    try { await this.runCommand(`docker restart ${id}`); return { data: true }; }
    catch (error) { return { data: false, error: String(error) }; }
  }
  async getContainerLogs(id: string, tail = 100): Promise<AdapterResult<string>> {
    try { const result = await this.runCommand(`docker logs --tail ${tail} ${id}`); return { data: result.stdout + result.stderr }; }
    catch (error) { return { data: '', error: String(error) }; }
  }
  async getContainerStats(id: string): Promise<AdapterResult<ContainerStats>> {
    try {
      const result = await this.runCommand(`docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}" ${id}`);
      const line = result.stdout.trim();
      if (!line) return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 } };
      const [cpu, memUsage, , netIO, blockIO] = line.split('|');
      return {
        data: {
          id, name: id,
          cpu_percent: parseFloat(cpu?.replace('%', '') || '0'),
          memory_mb: parseFloat(memUsage?.match(/([\d.]+)/)?.[1] || '0'),
          memory_limit_mb: parseFloat(memUsage?.match(/\/\s*([\d.]+)/)?.[1] || '0'),
          network_rx_mb: 0, network_tx_mb: 0,
          block_read_mb: 0, block_write_mb: 0,
        }
      };
    } catch (error) {
      return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 }, error: String(error) };
    }
  }
}