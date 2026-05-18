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

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  created: string;
  ports: string;
}

export interface ContainerStats {
  id: string;
  name: string;
  cpu_percent: number;
  memory_mb: number;
  memory_limit_mb: number;
  network_rx_mb: number;
  network_tx_mb: number;
  block_read_mb: number;
  block_write_mb: number;
}

export interface AdapterResult<T> {
  data: T;
  error?: string;
}

export interface OSAdapter {
  getOSInfo(): Promise<AdapterResult<OSInfo>>;
  getCPUInfo(): Promise<AdapterResult<CPUInfo>>;
  getMemoryInfo(): Promise<AdapterResult<MemoryInfo>>;
  listContainers(): Promise<AdapterResult<ContainerInfo[]>>;
  startContainer(id: string): Promise<AdapterResult<boolean>>;
  stopContainer(id: string): Promise<AdapterResult<boolean>>;
  restartContainer(id: string): Promise<AdapterResult<boolean>>;
  getContainerLogs(id: string, tail?: number): Promise<AdapterResult<string>>;
  getContainerStats(id: string): Promise<AdapterResult<ContainerStats>>;
}

export abstract class BaseOSAdapter {
  constructor(protected runCommand: (cmd: string) => Promise<CommandResult>) {}

  abstract getOSInfo(): Promise<AdapterResult<OSInfo>>;
  abstract getCPUInfo(): Promise<AdapterResult<CPUInfo>>;
  abstract getMemoryInfo(): Promise<AdapterResult<MemoryInfo>>;
  abstract listContainers(): Promise<AdapterResult<ContainerInfo[]>>;
  abstract startContainer(id: string): Promise<AdapterResult<boolean>>;
  abstract stopContainer(id: string): Promise<AdapterResult<boolean>>;
  abstract restartContainer(id: string): Promise<AdapterResult<boolean>>;
  abstract getContainerLogs(id: string, tail?: number): Promise<AdapterResult<string>>;
  abstract getContainerStats(id: string): Promise<AdapterResult<ContainerStats>>;
}