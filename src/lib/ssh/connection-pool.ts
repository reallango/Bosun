import { Client, ConnectConfig } from 'ssh2';

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

export interface PoolConfig {
  maxConnectionsPerServer: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  keepaliveIntervalMs: number;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConnectionsPerServer: 3,
  idleTimeoutMs: 300000,
  connectTimeoutMs: 10000,
  commandTimeoutMs: 30000,
  keepaliveIntervalMs: 30000
};

interface PooledConnection {
  client: Client;
  inUse: boolean;
  createdAt: number;
  lastUsed: number;
}

export class SSHConnectionPool {
  private pools: Map<string, PooledConnection[]> = new Map();
  private config: PoolConfig;

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  private getPoolKey(config: SSHConnectionConfig): string {
    return `${config.username}@${config.host}:${config.port}`;
  }

  async getConnection(serverId: string, sshConfig: SSHConnectionConfig): Promise<Client> {
    const poolKey = this.getPoolKey(sshConfig);
    let pool = this.pools.get(poolKey);
    
    if (!pool) {
      pool = [];
      this.pools.set(poolKey, pool);
    }

    // Find available connection
    const available = pool.find(c => !c.inUse && Date.now() - c.lastUsed < this.config.idleTimeoutMs);
    if (available) {
      available.inUse = true;
      available.lastUsed = Date.now();
      
      // Check if connection is still valid
      return new Promise((resolve, reject) => {
        available.client.exec('echo test', (err, stream) => {
          if (err) {
            available.inUse = false;
            this.createConnection(sshConfig).then(resolve).catch(reject);
          } else {
            resolve(available.client);
          }
        });
      });
    }

    // Create new connection if pool not full
    if (pool.length < this.config.maxConnectionsPerServer) {
      return this.createConnection(sshConfig);
    }

    // Wait for available connection
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const freed = pool!.find(c => !c.inUse);
        if (freed) {
          clearInterval(checkInterval);
          freed.inUse = true;
          freed.lastUsed = Date.now();
          resolve(freed.client);
        }
      }, 100);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Connection pool timeout'));
      }, this.config.connectTimeoutMs);
    });
  }

  private async createConnection(sshConfig: SSHConnectionConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const connConfig: ConnectConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        privateKey: sshConfig.privateKey,
        passphrase: sshConfig.passphrase,
        readyTimeout: this.config.connectTimeoutMs,
        keepaliveInterval: this.config.keepaliveIntervalMs
      };

      client.on('ready', () => {
        const poolKey = this.getPoolKey(sshConfig);
        const pool = this.pools.get(poolKey) || [];
        
        pool.push({
          client,
          inUse: true,
          createdAt: Date.now(),
          lastUsed: Date.now()
        });
        
        this.pools.set(poolKey, pool);
        resolve(client);
      });

      client.on('error', (err) => {
        reject(err);
      });

      client.connect(connConfig);
    });
  }

  async executeCommand(
    serverId: string,
    sshConfig: SSHConnectionConfig,
    command: string
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const client = await this.getConnection(serverId, sshConfig);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, this.config.commandTimeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          this.releaseConnection(serverId, client);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          clearTimeout(timeout);
          this.releaseConnection(serverId, client);
          resolve({
            stdout,
            stderr,
            exitCode: code,
            durationMs: Date.now() - startTime
          });
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
  }

  releaseConnection(serverId: string, client: Client): void {
    for (const pool of Array.from(this.pools.values())) {
      const conn = pool.find(c => c.client === client);
      if (conn) {
        conn.inUse = false;
        conn.lastUsed = Date.now();
        break;
      }
    }
  }

  async drainServer(serverId: string): Promise<void> {
    const poolKey = `${serverId}`;
    const pool = this.pools.get(poolKey);
    if (pool) {
      for (const conn of pool) {
        conn.client.end();
      }
      this.pools.delete(poolKey);
    }
  }

  async drainAll(): Promise<void> {
    for (const pool of Array.from(this.pools.values())) {
      for (const conn of pool) {
        conn.client.end();
      }
    }
    this.pools.clear();
  }

  getStats(): { servers: number; connections: number } {
    let connections = 0;
    for (const pool of Array.from(this.pools.values())) {
      connections += pool.length;
    }
    return {
      servers: this.pools.size,
      connections
    };
  }
}

export const sshPool = new SSHConnectionPool();