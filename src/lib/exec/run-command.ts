/**
 * Running one command on a host for the MCP `server_command` and `container_exec` tools, and for approved one-time
 * command requests.
 *
 * Deliberately neutral (no access-request or MCP imports) so approval code can run a command without a cycle. It uses
 * the same library functions as the REST exec routes: the non-admin shell account for `user`, the privileged service
 * account for `service`, the same rate limit and the same audit actions.
 */
import { loadShellTarget, assertShellAccountSafe, runOnShellTarget } from '@/lib/ssh/shell-target';
import { loadServerTarget, runOnServerId } from '@/lib/ssh/connection-pool';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';

export const MAX_COMMAND_LENGTH = 4000;
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type CommandAccount = 'user' | 'service';

export interface RunCommandOptions {
  serverId: string;
  command: string;
  as: CommandAccount;
  timeoutMs?: number;
  /** Who the audit entry names (the requester, for an approved request). */
  userId?: string;
  ip?: string;
  approvedBy?: string;
  requestId?: string;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  account: string;
  as: CommandAccount;
}

export class CommandError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'COMMAND_FAILED') {
    super(message);
  }
}

function validate(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new CommandError('command is required', 400, 'COMMAND_REQUIRED');
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new CommandError(`command is longer than ${MAX_COMMAND_LENGTH} characters`, 400, 'COMMAND_TOO_LONG');
  return trimmed;
}

function noteOf(opts: RunCommandOptions): string {
  return opts.approvedBy ? ` approved by ${opts.approvedBy}${opts.requestId ? ` (request ${opts.requestId})` : ''}` : '';
}

function timeoutOf(ms: number | undefined, fallback = 60_000): number {
  return Math.min(Math.max(Math.round(ms ?? fallback), 1000), 300_000);
}

/**
 * Give the command itself a deadline on the host. Closing the SSH channel from here does not reliably stop the remote
 * process (a `sleep 20` keeps the channel open until it exits), so a command that ignores the timeout would hold the
 * call — and an approved one-time run — open far longer than declared. `timeout` also kills the children it started.
 * Hosts without `timeout` run the command as before (no stronger guarantee than the channel close).
 */
export function withRemoteTimeout(platform: 'linux' | 'windows', command: string, timeoutMs: number): string {
  if (platform === 'windows') return command;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `if command -v timeout >/dev/null 2>&1; then timeout -k 5 ${seconds} sh -c ${shq(command)}; else sh -c ${shq(command)}; fi`;
}

/** `timeout` exits 124 when it stopped the command; the channel close is the local backstop. */
function stoppedByTimeout(r: { exitCode: number; timedOut?: boolean }): boolean {
  return !!r.timedOut || r.exitCode === 124;
}

/** Run one command as the host's non-admin shell account (or the privileged service account). */
export async function runServerCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const command = validate(opts.command);
  const timeoutMs = timeoutOf(opts.timeoutMs);
  const started = Date.now();
  const note = noteOf(opts);

  try {
    if (opts.as === 'user') {
      const target = await loadShellTarget(opts.serverId);
      await assertShellAccountSafe(target);
      const r = await runOnShellTarget(target, withRemoteTimeout(target.platform, command, timeoutMs), { timeoutMs });
      await logAudit({
        userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
        action: AuditActions.SERVER_SHELL_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
        details: `${target.config.username}: ${command.slice(0, 500)}${note}`.slice(0, 900), durationMs: Date.now() - started,
      });
      return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: stoppedByTimeout(r), account: target.config.username, as: 'user' };
    }
    const target = await loadServerTarget(opts.serverId);
    const r = await runOnServerId(opts.serverId, withRemoteTimeout(target.platform, command, timeoutMs), { timeoutMs });
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: AuditActions.SERVER_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
      details: `${command.slice(0, 500)}${note}`.slice(0, 900), durationMs: Date.now() - started,
    });
    return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: stoppedByTimeout(r), account: target.config.username, as: 'service' };
  } catch (error) {
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: opts.as === 'user' ? AuditActions.SERVER_SHELL_EXEC : AuditActions.SERVER_EXEC, status: 'failure',
      details: `refused or failed: ${String(error).slice(0, 200)}${note}`.slice(0, 900), durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Run one command inside a container as the host's service account.
 *
 * The command is passed to a shell *inside* the container (`docker exec <c> sh -c <command>`), never left in the host
 * command line: anything unquoted after the container name would run on the host, as an account that may have sudo and
 * Docker access, for a caller who only holds a grant for that one container.
 */
export async function runContainerCommand(opts: { serverId: string; container: string; command: string; timeoutMs?: number; userId?: string; ip?: string }): Promise<RunCommandResult> {
  const container = opts.container.trim();
  if (!CONTAINER_NAME_RE.test(container)) throw new CommandError('container must be a container name or id', 400, 'INVALID_CONTAINER');
  const command = validate(opts.command);
  const timeoutMs = timeoutOf(opts.timeoutMs);
  const started = Date.now();
  const run = `docker exec ${shq(container)} sh -c ${shq(command)}`;
  try {
    const target = await loadServerTarget(opts.serverId);
    const r = await runOnServerId(opts.serverId, withRemoteTimeout(target.platform, run, timeoutMs), { timeoutMs });
    if (r.exitCode !== 0 && /executable file not found|no such file or directory: sh\b/i.test(r.stderr)) {
      throw new CommandError('This container has no POSIX shell (sh), so a command cannot be run in it', 409, 'CONTAINER_NO_SHELL');
    }
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: AuditActions.SERVER_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
      details: `docker exec ${container}: ${command.slice(0, 400)}`, durationMs: Date.now() - started,
    });
    return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: stoppedByTimeout(r), account: 'service', as: 'service' };
  } catch (error) {
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: AuditActions.SERVER_EXEC, status: 'failure',
      details: `docker exec ${container}: refused or failed: ${String(error).slice(0, 200)}`, durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  }
}

/** Single-quote a value for a POSIX shell. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The same rate limit the REST exec routes use. */
export function commandRateLimited(userId: string): boolean {
  return !consumeActionRateLimit(userId).allowed;
}
