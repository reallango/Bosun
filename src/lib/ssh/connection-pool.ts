import { getMasterKey } from '@/lib/secrets';
import type { Client } from 'ssh2';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
// Shared CommonJS helpers (also used by poller.js / ws-server.js).
import * as sshHelpers from '@/lib/collect/ssh';
import { powershellCommand, cleanPowerShellOutput } from '@/lib/collect/windows';

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
  timedOut?: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  stdin?: string;
}

interface Entry {
  key: string;
  client: Client | null;
  connecting: Promise<Client> | null;
  lastUsed: number;
  serverId: string;
}

const IDLE_CLOSE_MS = 5 * 60 * 1000;

/**
 * One persistent SSH connection per (server, account), multiplexing exec
 * channels. The web app only needs SSH for user actions (container control,
 * model management, custom commands, detection); monitoring data comes from
 * the poller via the database. Idle connections close after 5 minutes.
 */
export class SSHConnectionPool {
  private entries = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout | null = null;

  private keyOf(serverId: string, cfg: SSHConnectionConfig) {
    return `${serverId}|${cfg.username}@${cfg.host}:${cfg.port}`;
  }

  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const e of Array.from(this.entries.values())) {
        if (now - e.lastUsed > IDLE_CLOSE_MS) this.drop(e);
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  private drop(e: Entry) {
    try { e.client?.end(); } catch { /* ignore */ }
    this.entries.delete(e.key);
  }

  async getConnection(serverId: string, cfg: SSHConnectionConfig): Promise<Client> {
    this.startSweeper();
    const key = this.keyOf(serverId, cfg);
    let e = this.entries.get(key);
    if (!e) {
      e = { key, client: null, connecting: null, lastUsed: Date.now(), serverId };
      this.entries.set(key, e);
    }
    e.lastUsed = Date.now();
    if (e.client) return e.client;
    if (e.connecting) return e.connecting;

    const entry = e;
    entry.connecting = (async () => {
      const fpRes = await rqlite.query('SELECT host_key_fingerprint FROM servers WHERE id = ?', [serverId]).catch(() => null);
      const expected = (fpRes?.values?.[0]?.[0] as string | null) || undefined;
      const client: Client = await sshHelpers.connect({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        privateKey: cfg.privateKey,
        passphrase: cfg.passphrase,
        expectedFingerprint: expected,
        onNewFingerprint: (fp: string) => {
          rqlite.execute('UPDATE servers SET host_key_fingerprint = ? WHERE id = ? AND host_key_fingerprint IS NULL', [fp, serverId])
            .catch(() => undefined);
        },
      });
      client.on('close', () => {
        if (entry.client === client) this.entries.delete(entry.key);
      });
      client.on('error', () => { /* surfaced through exec failures */ });
      entry.client = client;
      return client;
    })();
    try {
      return await entry.connecting;
    } catch (err) {
      this.entries.delete(key);
      throw err;
    } finally {
      entry.connecting = null;
    }
  }

  async executeCommand(serverId: string, cfg: SSHConnectionConfig, command: string, opts: ExecOptions = {}): Promise<CommandResult> {
    const client = await this.getConnection(serverId, cfg);
    try {
      return await sshHelpers.exec(client, command, { timeoutMs: opts.timeoutMs ?? 30000, stdin: opts.stdin });
    } catch (err) {
      // Channel could not be opened: the connection is dead. Retry once fresh.
      const e = this.entries.get(this.keyOf(serverId, cfg));
      if (e) this.drop(e);
      const fresh = await this.getConnection(serverId, cfg);
      return sshHelpers.exec(fresh, command, { timeoutMs: opts.timeoutMs ?? 30000, stdin: opts.stdin });
    }
  }

  /** Kept for API compatibility; channels need no release. */
  releaseConnection(): void { /* no-op */ }

  async drainServer(serverId: string): Promise<void> {
    for (const e of Array.from(this.entries.values())) {
      if (e.serverId === serverId) this.drop(e);
    }
  }

  async drainAll(): Promise<void> {
    for (const e of Array.from(this.entries.values())) this.drop(e);
  }

  getStats(): { servers: number; connections: number } {
    const servers = new Set(Array.from(this.entries.values()).map(e => e.serverId));
    return { servers: servers.size, connections: this.entries.size };
  }
}

// One pool per server process, shared by all route modules (survives HMR in dev).
const g = globalThis as unknown as { __bosunSshPool?: SSHConnectionPool };
export const sshPool: SSHConnectionPool = g.__bosunSshPool ?? (g.__bosunSshPool = new SSHConnectionPool());

export interface ServerTarget {
  id: string;
  name: string;
  platform: 'linux' | 'windows';
  config: SSHConnectionConfig;
}

/** Load a server's connection settings and decrypted key from the database. */
export async function loadServerTarget(serverId: string): Promise<ServerTarget> {
  const r = await rqlite.query(
    'SELECT s.id, s.name, s.hostname, s.ssh_port, s.ssh_user, s.platform, k.private_key_enc, k.passphrase_enc ' +
    'FROM servers s LEFT JOIN ssh_keys k ON k.id = s.ssh_key_id WHERE s.id = ?', [serverId]);
  const row = r.values?.[0];
  if (!row) throw Object.assign(new Error('Server not found'), { status: 404 });
  const [id, name, hostname, port, user, platform, keyEnc, passEnc] = row as (string | number | null)[];
  if (!keyEnc) throw Object.assign(new Error('No SSH key assigned to this server'), { status: 400 });
  const masterKey = getMasterKey();
  return {
    id: String(id),
    name: String(name),
    platform: platform === 'windows' ? 'windows' : 'linux',
    config: {
      host: String(hostname),
      port: Number(port) || 22,
      username: String(user),
      privateKey: decrypt(String(keyEnc), masterKey),
      passphrase: passEnc ? decrypt(String(passEnc), masterKey) : undefined,
    },
  };
}

/**
 * Run a command on a server by id. On Windows `command` is a PowerShell
 * script; on Linux a POSIX shell command.
 */
export async function runOnServerId(serverId: string, command: string, opts: ExecOptions = {}): Promise<CommandResult & { platform: 'linux' | 'windows' }> {
  const t = await loadServerTarget(serverId);
  const cmd = t.platform === 'windows' ? powershellCommand(command) : command;
  const r = await sshPool.executeCommand(t.id, t.config, cmd, opts);
  // PowerShell wraps its error and progress streams in CLIXML; show the plain text instead.
  return t.platform === 'windows'
    ? { ...r, stdout: cleanPowerShellOutput(r.stdout), stderr: cleanPowerShellOutput(r.stderr), platform: t.platform }
    : { ...r, platform: t.platform };
}
