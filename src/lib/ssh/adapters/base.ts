import { CommandResult } from '../connection-pool';

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

export interface AdapterResult<T> {
  data: T;
  error?: string;
}

export interface OSAdapter {
  getOSInfo(): Promise<AdapterResult<OSInfo>>;
  getCPUInfo(): Promise<AdapterResult<CPUInfo>>;
  getMemoryInfo(): Promise<AdapterResult<MemoryInfo>>;
}

export abstract class BaseOSAdapter {
  constructor(protected runCommand: (cmd: string) => Promise<CommandResult>) {}

  abstract getOSInfo(): Promise<AdapterResult<OSInfo>>;
  abstract getCPUInfo(): Promise<AdapterResult<CPUInfo>>;
  abstract getMemoryInfo(): Promise<AdapterResult<MemoryInfo>>;
}