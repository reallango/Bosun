import { getMasterKey } from '@/lib/secrets';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, type SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { SHELL_VERIFY_COMMAND, parseShellVerification } from '@/lib/ssh/shell-account';
import { WINDOWS_SHELL_VERIFY_COMMAND, parseWindowsShellVerification } from '@/lib/ssh/windows-shell-account';
import { powershellCommand, cleanPowerShellOutput } from '@/lib/collect/windows';
import type { CommandResult, ExecOptions } from '@/lib/ssh/connection-pool';

export interface ShellTarget {
  id: string;
  name: string;
  platform: 'linux' | 'windows';
  config: SSHConnectionConfig;
}

export class ShellUnavailableError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 409, code = 'SHELL_UNAVAILABLE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The connection settings of a server's NON-ADMIN shell account. This reads only the
 * shell key columns: the privileged account's key is never loaded here, so nothing built
 * on this can fall back to it.
 */
export async function loadShellTarget(serverId: string): Promise<ShellTarget> {
  const r = await rqlite.query(
    'SELECT s.id, s.name, s.hostname, s.ssh_port, s.platform, s.shell_user, k.private_key_enc, k.passphrase_enc ' +
    'FROM servers s LEFT JOIN ssh_keys k ON k.id = s.shell_key_id WHERE s.id = ?', [serverId]);
  const row = r.values?.[0];
  if (!row) throw Object.assign(new Error('Server not found'), { status: 404 });
  const [id, name, hostname, port, platform, shellUser, keyEnc, passEnc] = row as (string | number | null)[];
  if (!shellUser || !keyEnc) throw new ShellUnavailableError('This server has no non-admin shell account. Provision it again (Add Server) to create one.');
  const masterKey = getMasterKey();
  return {
    id: String(id),
    name: String(name),
    platform: platform === 'windows' ? 'windows' : 'linux',
    config: {
      host: String(hostname),
      port: Number(port) || 22,
      username: String(shellUser),
      privateKey: decrypt(String(keyEnc), masterKey),
      passphrase: passEnc ? decrypt(String(passEnc), masterKey) : undefined,
    },
  };
}

const VERIFIED_FOR_MS = 5 * 60 * 1000;
const verifiedAt = new Map<string, number>();

/**
 * Re-prove, by logging in as the shell account, that it still has no admin rights
 * (someone may have added it to a group since provisioning). Cached for a few minutes;
 * throws ShellUnavailableError if it is not safe or cannot be checked.
 */
export async function assertShellAccountSafe(target: ShellTarget): Promise<void> {
  const key = `${target.id}|${target.config.username}`;
  const last = verifiedAt.get(key);
  if (last && Date.now() - last < VERIFIED_FOR_MS) return;
  verifiedAt.delete(key);
  let stdout = '';
  try {
    const command = target.platform === 'windows' ? powershellCommand(WINDOWS_SHELL_VERIFY_COMMAND) : SHELL_VERIFY_COMMAND;
    stdout = (await sshPool.executeCommand(target.id, target.config, command, { timeoutMs: target.platform === 'windows' ? 30_000 : 15_000 })).stdout;
  } catch (err) {
    throw new ShellUnavailableError(`Could not log in as the shell account: ${String(err).slice(0, 160)}`, 502, 'SHELL_LOGIN_FAILED');
  }
  const v = target.platform === 'windows'
    ? parseWindowsShellVerification(stdout, target.config.username)
    : parseShellVerification(stdout, target.config.username);
  if (!v.ok) {
    await sshPool.drainServer(target.id);
    throw new ShellUnavailableError(`The shell account is not safe to use: ${v.problems.join('; ')}`, 409, 'SHELL_ACCOUNT_UNSAFE');
  }
  verifiedAt.set(key, Date.now());
}

/**
 * Run a command as the shell account. On Windows `command` is a PowerShell script (wrapped
 * for exec); on Linux a POSIX shell command. Output is cleaned of PowerShell's XML wrapper.
 */
export async function runOnShellTarget(target: ShellTarget, command: string, opts: ExecOptions = {}): Promise<CommandResult> {
  const wrapped = target.platform === 'windows' ? powershellCommand(command) : command;
  const r = await sshPool.executeCommand(target.id, target.config, wrapped, opts);
  return target.platform === 'windows' ? { ...r, stdout: cleanPowerShellOutput(r.stdout), stderr: cleanPowerShellOutput(r.stderr) } : r;
}
