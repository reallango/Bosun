/**
 * Running commands on a host as the administrator whose password the person typed (provisioning
 * and key cleanup). The password is used for this one call and never stored.
 *
 * Host keys: a host Bosun already knows is held to its pinned fingerprint
 * (servers.host_key_fingerprint), so a spoofed host never sees the password.
 * A new host is trusted on first use, and every later connection in the same
 * request is held to the key seen first (`hostKey` is filled in then).
 */
import { rqlite } from '@/lib/db/rqlite-client';
import * as sshHelpers from '@/lib/collect/ssh';

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Expected host key fingerprint (SHA256:...). Filled in by the first connection when unset. */
  hostKey?: string;
}

/** A command plus what to feed it on stdin (keeps the sudo password off the host's process list). */
export interface RootCommand { command: string; stdin: string }

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/**
 * The fingerprint pinned for this host, if Bosun has one: by server id, else
 * by address. Throws when the database cannot be read (never fails open).
 */
export async function pinnedHostKey(target: { serverId?: string | null; host: string; port: number }): Promise<string | undefined> {
  const res = target.serverId
    ? await rqlite.query('SELECT host_key_fingerprint FROM servers WHERE id = ?', [target.serverId])
    : await rqlite.query(
      'SELECT host_key_fingerprint FROM servers WHERE LOWER(hostname) = LOWER(?) AND COALESCE(ssh_port, 22) = ? AND host_key_fingerprint IS NOT NULL LIMIT 1',
      [target.host, Number(target.port) || 22]);
  const fp = res.values?.[0]?.[0];
  return typeof fp === 'string' && fp ? fp : undefined;
}

/** Connect with the host key check: pinned when known, else trust on first use (recorded in `pin.hostKey`). */
export async function connectPinned(
  opts: { host: string; port: number; username: string; password?: string; privateKey?: string },
  pin: { hostKey?: string },
): Promise<import('ssh2').Client> {
  return sshHelpers.connect({
    ...opts,
    readyTimeout: 10000,
    keepaliveInterval: 0,
    expectedFingerprint: pin.hostKey,
    onNewFingerprint: (fp: string) => { if (!pin.hostKey) pin.hostKey = fp; },
  });
}

/** Run a command over SSH with a password. */
export async function sshExec(config: SshAuth, command: string | RootCommand): Promise<ExecResult> {
  const cmd = typeof command === 'string' ? { command, stdin: undefined } : command;
  const conn = await withTimeout(connectPinned(config, config), 15000, 'SSH connection timeout');
  try {
    const r = await sshHelpers.exec(conn, cmd.command, { stdin: cmd.stdin, timeoutMs: 120000 });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}

/** Run one command over SSH with a private key, held to `pin.hostKey` the same way. */
export async function sshExecWithKey(
  target: { host: string; port: number; username: string; privateKey: string },
  command: string,
  pin: { hostKey?: string },
): Promise<ExecResult> {
  const conn = await withTimeout(connectPinned(target, pin), 15000, 'SSH connection timeout');
  try {
    const r = await sshHelpers.exec(conn, command, { timeoutMs: 30000 });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export function stripSudo(stderr: string): string {
  return stderr.replace(/^\[sudo\]/gm, '').trim();
}

/** Single-quote a value for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wrap a script so it runs as root on the host: directly when the admin user is
 * root, otherwise through sudo with the admin password, which goes in on stdin
 * (never on the command line, where other users of the host could see it). The
 * script travels base64-encoded so it can contain any quoting.
 */
export function asRootCommand(sshConfig: SshAuth, adminPassword: string, script: string): RootCommand {
  // The script's own stdin is closed first, so it can never read the password
  // (sudo may not ask for it: NOPASSWD, or a cached sudo timestamp).
  const body = `exec </dev/null\n${script}`;
  const run = `sh -c "$(printf %s '${Buffer.from(body).toString('base64')}' | base64 -d)"`;
  return sshConfig.username === 'root'
    ? { command: run, stdin: '' }
    : { command: `sudo -S -p '' ${run}`, stdin: `${adminPassword}\n` };
}
