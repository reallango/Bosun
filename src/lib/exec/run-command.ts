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

/** Run one command as the host's non-admin shell account (or the privileged service account). */
export async function runServerCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const command = validate(opts.command);
  const timeoutMs = Math.min(Math.max(Math.round(opts.timeoutMs ?? 60_000), 1000), 300_000);
  const started = Date.now();
  const note = noteOf(opts);

  try {
    if (opts.as === 'user') {
      const target = await loadShellTarget(opts.serverId);
      await assertShellAccountSafe(target);
      const r = await runOnShellTarget(target, command, { timeoutMs });
      await logAudit({
        userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
        action: AuditActions.SERVER_SHELL_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
        details: `${target.config.username}: ${command.slice(0, 500)}${note}`.slice(0, 900), durationMs: Date.now() - started,
      });
      return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut, account: target.config.username, as: 'user' };
    }
    const target = await loadServerTarget(opts.serverId);
    const r = await runOnServerId(opts.serverId, command, { timeoutMs });
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: AuditActions.SERVER_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
      details: `${command.slice(0, 500)}${note}`.slice(0, 900), durationMs: Date.now() - started,
    });
    return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut, account: target.config.username, as: 'service' };
  } catch (error) {
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: opts.as === 'user' ? AuditActions.SERVER_SHELL_EXEC : AuditActions.SERVER_EXEC, status: 'failure',
      details: `refused or failed: ${String(error).slice(0, 200)}${note}`.slice(0, 900), durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  }
}

/** Run one `docker exec` as the host's service account. */
export async function runContainerCommand(opts: { serverId: string; container: string; command: string; timeoutMs?: number; userId?: string; ip?: string }): Promise<RunCommandResult> {
  const container = opts.container.trim();
  if (!CONTAINER_NAME_RE.test(container)) throw new CommandError('container must be a container name or id', 400, 'INVALID_CONTAINER');
  const command = validate(opts.command);
  const timeoutMs = Math.min(Math.max(Math.round(opts.timeoutMs ?? 60_000), 1000), 300_000);
  const started = Date.now();
  try {
    const r = await runOnServerId(opts.serverId, `docker exec ${shq(container)} ${command}`, { timeoutMs });
    await logAudit({
      userId: opts.userId, serverId: opts.serverId, ipAddress: opts.ip,
      action: AuditActions.SERVER_EXEC, status: r.exitCode === 0 ? 'success' : 'failure',
      details: `docker exec ${container}: ${command.slice(0, 400)}`, durationMs: Date.now() - started,
    });
    return { stdout: r.stdout.slice(0, 256 * 1024), stderr: r.stderr.slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut, account: 'service', as: 'service' };
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
