import { BaseOSAdapter, AdapterResult, OSInfo, CPUInfo, MemoryInfo } from './base';

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
}