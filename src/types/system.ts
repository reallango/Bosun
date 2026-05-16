export interface OSInfo {
  os_type: string;
  os_version: string;
  os_codename: string;
  kernel_version: string;
  hostname: string;
}

export interface CPUInfo {
  model: string;
  cores: number;
}

export interface MemoryInfo {
  total_mb: number;
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