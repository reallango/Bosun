/**
 * Host tools that are not thin REST wrappers: one-off commands, `docker exec`, and persistent terminal sessions.
 *
 * Permission rules match the REST exec/terminal routes. When the caller lacks the permission, `server_command` (and
 * `terminal_open` for a host shell) creates a one-time access request instead of only failing, so a person can approve
 * exactly that command or session.
 */
import type { ActionContext } from './actions';
import type { CatalogTool, ObjectJsonSchema, ToolResult } from './types';
import { hasPermission, requirePermission } from '@/lib/permissions/authorize';
import { createRequest } from '@/lib/access/requests';
import { accessRequestLimiter } from '@/lib/access/limiter';
import { validateRequestInput } from '@/lib/access/validate';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { runServerCommand, runContainerCommand, commandRateLimited, CommandError, type RunCommandResult } from '@/lib/exec/run-command';
import { CONTAINER_SHELL_PERMISSION } from '@/lib/exec/container-permission';
import { getMcpTerminalManager, principalKey, TerminalError, type TerminalOutput } from '@/lib/terminal/mcp-sessions';
import { errorResult, textResult, truncate } from './format';
import { toolErrorFromResponse } from './errors';

const SERVER_ID = { type: 'string', minLength: 1, maxLength: 128, description: 'Server id (call servers_list to find one).' };
const SESSION_ID = { type: 'string', minLength: 1, maxLength: 128, description: 'Terminal session id from terminal_open.' };
const ACCOUNT = { type: 'string', enum: ['user', 'service'], description: 'user = the non-admin shell account; service = the privileged service account.' };
const TIMEOUT = { type: 'integer', minimum: 1, maximum: 300, description: 'Seconds to allow (default 60, at most 300).' };

function noArgs(): ObjectJsonSchema {
  return { type: 'object', properties: {}, additionalProperties: false };
}

function object(properties: Record<string, unknown>, required: string[] = []): ObjectJsonSchema {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function formatCommand(r: RunCommandResult): string {
  const lines = [`Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`, `Account: ${r.account} (${r.as})`];
  if (r.stdout) lines.push(`stdout:\n${truncate(r.stdout, 6000)}`);
  if (r.stderr) lines.push(`stderr:\n${truncate(r.stderr, 3000)}`);
  if (!r.stdout && !r.stderr) lines.push('(no output)');
  return lines.join('\n');
}

function commandResult(r: RunCommandResult) {
  return {
    stdout: r.stdout.slice(0, 60_000), stderr: r.stderr.slice(0, 60_000),
    exit_code: r.exitCode, timed_out: r.timedOut, account: r.account, as: r.as,
  };
}

function formatTerminalOutput(r: TerminalOutput): string {
  const lines = [r.output || '(no new output)'];
  if (r.more) lines.push('… (more output is waiting; call terminal_read)');
  if (r.password_required) lines.push('Password prompt detected. A person must type the password; do not send it through this tool.');
  return lines.join('\n');
}

function terminalResult(r: TerminalOutput) {
  return { output: r.output, more: r.more, password_required: r.password_required };
}

export function hostTools(): CatalogTool[] {
  return [
    {
      kind: 'host', hostName: 'server_command', name: 'server_command', title: 'Run one command on a host',
      description: [
        'Run one command on a host and return stdout, stderr and the exit code (truncated).',
        'as "user" runs it as the host\'s non-admin shell account (shell.user); as "service" runs it as the privileged service account (exec.service), PowerShell on Windows.',
        'Without the permission the tool creates a one-time access request carrying the exact command and account, and returns its id; a person approves that single run. Use access_request_wait for the result.',
        'Use servers_list to find server ids. For an interactive shell use terminal_open instead.',
      ].join(' '),
      inputSchema: object({
        server_id: SERVER_ID, command: { type: 'string', minLength: 1, maxLength: 4000, description: 'The command to run.' },
        as: ACCOUNT, timeout: TIMEOUT,
        reason: { type: 'string', maxLength: 500, description: 'Why you need it (used in the access request).' },
      }, ['server_id', 'command', 'as']),
      annotations: { readOnlyHint: false, openWorldHint: true },
      routes: ['POST servers/[serverId]/exec', 'POST servers/[serverId]/shell/exec'],
    },
    {
      kind: 'host', hostName: 'container_exec', name: 'container_exec', title: 'Run one command in a container',
      description: 'Run one `docker exec` in a container as the host\'s service account and return stdout, stderr and the exit code. Needs container shell access (the Docker package permission). For an interactive shell use terminal_open with container.',
      inputSchema: object({
        server_id: SERVER_ID, container: { type: 'string', minLength: 1, maxLength: 128, description: 'Container name or id.' },
        command: { type: 'string', minLength: 1, maxLength: 4000, description: 'The command to run in the container.' },
        timeout: TIMEOUT,
      }, ['server_id', 'container', 'command']),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    {
      kind: 'host', hostName: 'terminal_open', name: 'terminal_open', title: 'Open a terminal session',
      description: [
        'Open a persistent PTY session on a host and return its session_id.',
        'as "user" uses the non-admin shell account (shell.user); as "service" uses the privileged service account (exec.service).',
        'Pass container to open an interactive shell in a container instead; a container session always runs as the service account and needs container shell access.',
        'Without the permission a one-time access request is created for one host-shell session (not for containers).',
        'Sessions belong to the principal that opened them, live on the node that opened them (a call on another node answers "Session not found on this node"), close after 15 idle minutes and are capped at 4 per principal.',
      ].join(' '),
      inputSchema: object({
        server_id: SERVER_ID, as: ACCOUNT,
        container: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional container name or id for an interactive container shell.' },
        reason: { type: 'string', maxLength: 500, description: 'Why you need it (used in the access request).' },
      }, ['server_id', 'as']),
      annotations: { readOnlyHint: false, openWorldHint: true },
      routes: ['POST servers/[serverId]/terminal'],
    },
    {
      kind: 'host', hostName: 'terminal_send', name: 'terminal_send', title: 'Send input to a terminal',
      description: [
        'Send input to a session, wait until its output is quiet for a short time or wait_ms passes, then return the new output since the last read (ANSI stripped).',
        'Input may contain control keys: {ctrl-a}..{ctrl-z}, {tab}, {enter}, {esc}, {backspace}, {up}, {down}, {left}, {right}, {home}, {end}, {pageup}, {pagedown}, {delete}, {space}.',
        'A "more" flag means more output is waiting: call terminal_read. If password_required is true the PTY is asking for a password; a person must type it and you must not.',
      ].join(' '),
      inputSchema: object({
        session_id: SESSION_ID, input: { type: 'string', maxLength: 4000, description: 'Text and control keys to send.' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'How long to collect output (default 1000 ms).' },
      }, ['session_id', 'input']),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    {
      kind: 'host', hostName: 'terminal_read', name: 'terminal_read', title: 'Read terminal output',
      description: 'Return further output from a session without sending input, after waiting up to wait_ms for it to become quiet.',
      inputSchema: object({
        session_id: SESSION_ID, wait_ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'How long to collect output (default 1000 ms).' },
      }, ['session_id']),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'host', hostName: 'terminal_screen', name: 'terminal_screen', title: 'Read the terminal screen',
      description: 'The current screen as plain text, rendered with a headless terminal emulator. Use this for full-screen programs such as htop, vim and less.',
      inputSchema: object({ session_id: SESSION_ID }, ['session_id']),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'host', hostName: 'terminal_close', name: 'terminal_close', title: 'Close a terminal session',
      description: 'Close a terminal session. Idle sessions close by themselves after 15 minutes.',
      inputSchema: object({ session_id: SESSION_ID }, ['session_id']),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
  ];
}

export async function callHostTool(ctx: ActionContext, tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (tool.hostName) {
      case 'server_command': return await serverCommand(ctx, args);
      case 'container_exec': return await containerExec(ctx, args);
      case 'terminal_open': return await terminalOpen(ctx, args);
      case 'terminal_send': return await terminalSend(ctx, args);
      case 'terminal_read': return await terminalRead(ctx, args);
      case 'terminal_screen': return await terminalScreen(ctx, args);
      case 'terminal_close': return await terminalClose(ctx, args);
      default: return errorResult(`Unknown tool: ${tool.name}`);
    }
  } catch (error) {
    if (error instanceof TerminalError || error instanceof CommandError) return errorResult(error.message);
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function apiKeyOnly(ctx: ActionContext) {
  if (ctx.auth.authType === 'api_key' && ctx.auth.apiKeyId) return null;
  return errorResult('Host commands and MCP terminal sessions are for API keys only; signed-in people should use the web terminal with their own login.');
}

async function serverCommand(ctx: ActionContext, args: Record<string, unknown>) {
  const notApiKey = apiKeyOnly(ctx);
  if (notApiKey) return notApiKey;
  const serverId = requiredString(args.server_id, 'server_id');
  const command = requiredString(args.command, 'command');
  const as = args.as === 'service' ? 'service' as const : args.as === 'user' ? 'user' as const : null;
  if (!as) return errorResult('as must be "user" or "service"');
  const permission = as === 'user' ? 'shell.user' : 'exec.service';

  if (!(await hasPermission(ctx.auth, permission, serverId))) {
    if (!accessRequestLimiter.consume(String(ctx.auth.userId)).allowed) return errorResult('Too many access requests; try again later (RATE_LIMITED).');
    const defs = await registeredPermissionDefs();
    const input = validateRequestInput({ kind: 'command', server_id: serverId, command, as, reason: args.reason }, defs);
    if (!input.ok) return errorResult(input.error);
    const request = await createRequest(ctx.auth, input.value);
    return textResult(
      `You do not hold "${permission}" on this server. Created one-time access request ${request.id}: ${request.summary}. A person must approve it; then use access_request_wait with request_id "${request.id}" to get the result.`,
      { request_id: request.id, status: request.status, summary: request.summary },
    );
  }

  if (commandRateLimited(String(ctx.auth.userId))) return errorResult('Too many commands, slow down (RATE_LIMITED).');
  const r = await runServerCommand({ serverId, command, as, timeoutMs: intArg(args.timeout, 60, 1, 300) * 1000, userId: String(ctx.auth.userId), ip: ctx.ip });
  return textResult(formatCommand(r), commandResult(r));
}

async function containerExec(ctx: ActionContext, args: Record<string, unknown>) {
  const notApiKey = apiKeyOnly(ctx);
  if (notApiKey) return notApiKey;
  const serverId = requiredString(args.server_id, 'server_id');
  const container = requiredString(args.container, 'container');
  const command = requiredString(args.command, 'command');
  const denied = await requirePermission(ctx.auth, CONTAINER_SHELL_PERMISSION, serverId, { kind: 'container', name: container });
  if (denied) return errorResult(await toolErrorFromResponse(denied, 'Not permitted: requires the container shell permission'));
  if (commandRateLimited(String(ctx.auth.userId))) return errorResult('Too many commands, slow down (RATE_LIMITED).');
  const r = await runContainerCommand({ serverId, container, command, timeoutMs: intArg(args.timeout, 60, 1, 300) * 1000, userId: String(ctx.auth.userId), ip: ctx.ip });
  return textResult(formatCommand(r), commandResult(r));
}

async function terminalOpen(ctx: ActionContext, args: Record<string, unknown>) {
  const notApiKey = apiKeyOnly(ctx);
  if (notApiKey) return notApiKey;
  const serverId = requiredString(args.server_id, 'server_id');
  const as = args.as === 'service' ? 'service' as const : args.as === 'user' ? 'user' as const : null;
  if (!as) return errorResult('as must be "user" or "service"');
  const container = typeof args.container === 'string' && args.container.trim() ? args.container.trim() : null;
  const account = container ? 'service' as const : as;
  const permission = container ? CONTAINER_SHELL_PERMISSION : account === 'user' ? 'shell.user' : 'exec.service';

  if (container) {
    const denied = await requirePermission(ctx.auth, permission, serverId, { kind: 'container', name: container });
    if (denied) return errorResult(await toolErrorFromResponse(denied, 'Not permitted'));
  } else if (!(await hasPermission(ctx.auth, permission, serverId))) {
    if (!accessRequestLimiter.consume(String(ctx.auth.userId)).allowed) return errorResult('Too many access requests; try again later (RATE_LIMITED).');
    const defs = await registeredPermissionDefs();
    const input = validateRequestInput({ kind: 'terminal', server_id: serverId, as: account, container: null, reason: args.reason }, defs);
    if (!input.ok) return errorResult(input.error);
    const request = await createRequest(ctx.auth, input.value);
    return textResult(
      `You do not hold "${permission}" on this server. Created one-time access request ${request.id}: ${request.summary}. A person must approve it; then use access_request_wait with request_id "${request.id}" to receive the session id.`,
      { request_id: request.id, status: request.status, summary: request.summary },
    );
  }

  if (commandRateLimited(String(ctx.auth.userId))) return errorResult('Too many requests, slow down (RATE_LIMITED).');
  const opened = await getMcpTerminalManager().open(principalKey(ctx.auth), ctx.auth, { serverId, as: account, container, ip: ctx.ip });
  return textResult(
    `Terminal session ${opened.session_id} opened on ${serverId} as ${opened.as}${container ? ` in container ${container}` : ''}. It closes after ${opened.idle_timeout_sec / 60} idle minutes.`,
    { ...opened },
  );
}

async function terminalSend(ctx: ActionContext, args: Record<string, unknown>) {
  const sessionId = requiredString(args.session_id, 'session_id');
  const input = typeof args.input === 'string' ? args.input : '';
  const r = await getMcpTerminalManager().send(principalKey(ctx.auth), sessionId, input, intArg(args.wait_ms, 1000, 0, 30000), ctx.auth, ctx.ip);
  return textResult(formatTerminalOutput(r), terminalResult(r));
}

async function terminalRead(ctx: ActionContext, args: Record<string, unknown>) {
  const sessionId = requiredString(args.session_id, 'session_id');
  const r = await getMcpTerminalManager().read(principalKey(ctx.auth), sessionId, intArg(args.wait_ms, 1000, 0, 30000));
  return textResult(formatTerminalOutput(r), terminalResult(r));
}

async function terminalScreen(ctx: ActionContext, args: Record<string, unknown>) {
  const sessionId = requiredString(args.session_id, 'session_id');
  const screen = await getMcpTerminalManager().screenText(principalKey(ctx.auth), sessionId);
  return textResult(screen || '(the screen is empty)', { session_id: sessionId, screen });
}

async function terminalClose(ctx: ActionContext, args: Record<string, unknown>) {
  const sessionId = requiredString(args.session_id, 'session_id');
  const closed = await getMcpTerminalManager().close(principalKey(ctx.auth), sessionId, ctx.auth, ctx.ip);
  if (!closed) return errorResult('Session not found on this node (sessions are node-local and belong to the principal that opened them)');
  return textResult(`Terminal session ${sessionId} closed.`, { session_id: sessionId, closed: true });
}

