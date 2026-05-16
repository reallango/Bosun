export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface PoolStats {
  servers: number;
  connections: number;
  busyConnections: number;
  idleConnections: number;
}