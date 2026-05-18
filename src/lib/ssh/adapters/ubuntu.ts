import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo, ContainerInfo, ContainerStats } from './base';

export class UbuntuAdapter extends BaseOSAdapter {
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
          os_type: parsed['ID'] || 'ubuntu',
          os_version: parsed['VERSION_ID'] || '',
          os_codename: parsed['VERSION_CODENAME'] || '',
          kernel_version: kernel.stdout.trim(),
          hostname: hostname.stdout.trim(),
        }
      };
    } catch (error) {
      return {
        data: { os_type: 'ubuntu', os_version: '', os_codename: '', kernel_version: '', hostname: '' },
        error: String(error)
      };
    }
  }

  async getCPUInfo(): Promise<AdapterResult<CPUInfo>> {
    try {
      const result = await this.runCommand('lscpu');
      const lines = result.stdout.split('\n');
      let model = 'Unknown';
      let cores = 1;

      for (const line of lines) {
        if (line.startsWith('Model name:')) {
          model = line.split(':')[1]?.trim() || model;
        }
        if (line.startsWith('CPU(s):')) {
          cores = parseInt(line.split(':')[1]?.trim() || '1', 10);
        }
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
      const totalKb = match ? parseInt(match[1], 10) : 0;
      return { data: { total_mb: Math.round(totalKb / 1024) } };
    } catch (error) {
      return { data: { total_mb: 0 }, error: String(error) };
    }
  }

  async listContainers(): Promise<AdapterResult<ContainerInfo[]>> {
    try {
      const result = await this.runCommand(
        'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.CreatedAt}}|{{.Ports}}"'
      );
      if (!result.stdout.trim()) {
        return { data: [] };
      }
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
    try {
      await this.runCommand(`docker start ${id}`);
      return { data: true };
    } catch (error) {
      return { data: false, error: String(error) };
    }
  }

  async stopContainer(id: string): Promise<AdapterResult<boolean>> {
    try {
      await this.runCommand(`docker stop ${id}`);
      return { data: true };
    } catch (error) {
      return { data: false, error: String(error) };
    }
  }

  async restartContainer(id: string): Promise<AdapterResult<boolean>> {
    try {
      await this.runCommand(`docker restart ${id}`);
      return { data: true };
    } catch (error) {
      return { data: false, error: String(error) };
    }
  }

  async getContainerLogs(id: string, tail = 100): Promise<AdapterResult<string>> {
    try {
      const result = await this.runCommand(`docker logs --tail ${tail} ${id}`);
      return { data: result.stdout + result.stderr };
    } catch (error) {
      return { data: '', error: String(error) };
    }
  }

  async getContainerStats(id: string): Promise<AdapterResult<ContainerStats>> {
    try {
      // Get single container stats in no-stream format
      const result = await this.runCommand(
        `docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}" ${id}`
      );
      const line = result.stdout.trim();
      if (!line) {
        return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 } };
      }
      const [cpu, memUsage, memPerc, netIO, blockIO] = line.split('|');
      
      // Parse memory: "123.4MiB / 2GiB" -> 123.4, 2048
      const memMatch = memUsage?.match(/([\d.]+)([KMGT]?i?B)\s*\/\s*([\d.]+)([KMGT]?i?B)/);
      let memory_mb = 0, memory_limit_mb = 0;
      if (memMatch) {
        const sizeToMb = (val: number, unit: string) => {
          if (unit.startsWith('G')) return val * 1024;
          if (unit.startsWith('M')) return val;
          if (unit.startsWith('K')) return val / 1024;
          return val / 1024 / 1024;
        };
        memory_mb = sizeToMb(parseFloat(memMatch[1]), memMatch[2]);
        memory_limit_mb = sizeToMb(parseFloat(memMatch[3]), memMatch[4]);
      }

      // Parse network: "1.5MB / 2KB" -> RX, TX
      const netMatch = netIO?.match(/([\d.]+)([KMGT]?B)\s*\/\s*([\d.]+)([KMGT]?B)/);
      let network_rx_mb = 0, network_tx_mb = 0;
      if (netMatch) {
        const sizeToMb = (val: number, unit: string) => {
          if (unit.startsWith('G')) return val * 1024;
          if (unit.startsWith('M')) return val;
          if (unit.startsWith('K')) return val / 1024;
          return val / 1024 / 1024;
        };
        network_rx_mb = sizeToMb(parseFloat(netMatch[1]), netMatch[2]);
        network_tx_mb = sizeToMb(parseFloat(netMatch[3]), netMatch[4]);
      }

      // Parse block: "1MB / 2KB"
      const blockMatch = blockIO?.match(/([\d.]+)([KMGT]?B)\s*\/\s*([\d.]+)([KMGT]?B)/);
      let block_read_mb = 0, block_write_mb = 0;
      if (blockMatch) {
        const sizeToMb = (val: number, unit: string) => {
          if (unit.startsWith('G')) return val * 1024;
          if (unit.startsWith('M')) return val;
          if (unit.startsWith('K')) return val / 1024;
          return val / 1024 / 1024;
        };
        block_read_mb = sizeToMb(parseFloat(blockMatch[1]), blockMatch[2]);
        block_write_mb = sizeToMb(parseFloat(blockMatch[3]), blockMatch[4]);
      }

      const cpuPercent = parseFloat(cpu?.replace('%', '') || '0');

      return {
        data: {
          id,
          name: id,
          cpu_percent: cpuPercent,
          memory_mb,
          memory_limit_mb,
          network_rx_mb,
          network_tx_mb,
          block_read_mb,
          block_write_mb,
        }
      };
    } catch (error) {
      return { data: { id, name: id, cpu_percent: 0, memory_mb: 0, memory_limit_mb: 0, network_rx_mb: 0, network_tx_mb: 0, block_read_mb: 0, block_write_mb: 0 }, error: String(error) };
    }
  }
}