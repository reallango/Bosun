/**
 * `server_command` and the terminal tools at the MCP layer: which account is used, the one-time request fallback, and
 * that a missing permission never runs anything. The SSH and database boundaries are faked (they are external
 * systems); the real `runServerCommand` is covered in src/lib/exec/run-command.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  permissions: new Set<string>(),
  runs: [] as Array<Record<string, unknown>>,
  containerRuns: [] as Array<Record<string, unknown>>,
  requests: [] as Array<Record<string, unknown>>,
  openCalls: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  terminalOutput: { output: 'done\n', more: false, password_required: false },
  closeFound: true,
}));

vi.mock('@/lib/permissions/authorize', () => ({
  hasPermission: async (_auth: unknown, permission: string) => h.permissions.has(permission),
  requirePermission: async (_auth: unknown, permission: string) => {
    if (h.permissions.has(permission)) return null;
    return new Response(JSON.stringify({ error: { message: `Not permitted: requires "${permission}"`, permission } }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  },
}));
vi.mock('@/lib/permissions/store', () => ({ registeredPermissionDefs: async () => [] }));
vi.mock('@/lib/access/requests', () => ({
  createRequest: async (_auth: unknown, input: Record<string, unknown>) => {
    h.requests.push(input);
    return { id: 'req-1', status: 'pending', kind: input.kind, summary: `summary of ${String(input.command ?? input.as)}` };
  },
}));
vi.mock('@/lib/exec/run-command', () => ({
  runServerCommand: async (opts: Record<string, unknown>) => {
    h.runs.push(opts);
    return { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, account: opts.as === 'service' ? 'root' : 'deploy', as: opts.as };
  },
  runContainerCommand: async (opts: Record<string, unknown>) => {
    h.containerRuns.push(opts);
    return { stdout: 'container\n', stderr: '', exitCode: 0, timedOut: false, account: 'root', as: 'service' };
  },
  commandRateLimited: () => false,
}));
vi.mock('@/lib/terminal/mcp-sessions', () => ({
  getMcpTerminalManager: () => ({
    open: async (owner: string, _auth: unknown, opts: Record<string, unknown>) => {
      h.openCalls.push({ owner, ...opts });
      return { session_id: 'sess-1', server_id: opts.serverId, as: opts.as, container: opts.container ?? null, idle_timeout_sec: 900 };
    },
    send: async (owner: string, sessionId: string, input: string) => { h.sent.push({ owner, sessionId, input }); return h.terminalOutput; },
    read: async () => h.terminalOutput,
    screenText: async () => 'screen text',
    close: async () => h.closeFound,
  }),
  principalKey: (auth: { userId?: string }) => `user:${String(auth.userId)}`,
  TerminalError: class TerminalError extends Error {},
}));

import { hostTools, callHostTool } from './host-tools';
import type { ActionContext } from './actions';

const ctx = { auth: { userId: 'u1', username: 'u', role: 'operator', authType: 'api_key', apiKeyId: 'key-1' }, ip: '10.0.0.1' } as unknown as ActionContext;
const tool = (name: string) => hostTools().find(t => t.name === name)!;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

describe('server_command', () => {
  beforeEach(() => { h.permissions = new Set(); h.runs.length = 0; h.requests.length = 0; });

  it('runs as the non-admin account when the caller holds shell.user', async () => {
    h.permissions.add('shell.user');
    const result = await callHostTool(ctx, tool('server_command'), { server_id: 'srv-1', command: 'uptime', as: 'user', timeout: 5 });
    expect(h.runs[0]).toMatchObject({ serverId: 'srv-1', command: 'uptime', as: 'user', timeoutMs: 5_000, userId: 'u1' });
    expect(h.requests).toHaveLength(0);
    expect(textOf(result)).toContain('Exit code: 0');
    expect(result.structuredContent).toMatchObject({ exit_code: 0, as: 'user', account: 'deploy' });
  });

  it('runs as the service account when the caller holds exec.service', async () => {
    h.permissions.add('exec.service');
    const result = await callHostTool(ctx, tool('server_command'), { server_id: 'srv-1', command: 'id', as: 'service' });
    expect(h.runs[0]).toMatchObject({ as: 'service', command: 'id' });
    expect(result.structuredContent).toMatchObject({ as: 'service', account: 'root' });
  });

  it('creates a one-time request with the exact command and account instead of failing', async () => {
    const result = await callHostTool(ctx, tool('server_command'), { server_id: 'srv-1', command: 'systemctl restart nginx', as: 'service', reason: 'restart' });
    expect(h.runs).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ kind: 'command', serverId: 'srv-1', command: 'systemctl restart nginx', as: 'service', reason: 'restart' });
    expect(result.structuredContent).toMatchObject({ request_id: 'req-1', status: 'pending' });
    expect(textOf(result)).toContain('one-time access request req-1');
  });

  it('refuses a signed-in principal (host commands use API keys only)', async () => {
    h.permissions.add('exec.service');
    const session = { ...ctx, auth: { ...ctx.auth, authType: 'user', apiKeyId: undefined } } as unknown as ActionContext;
    const result = await callHostTool(session, tool('server_command'), { server_id: 'srv-1', command: 'id', as: 'service' });
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain('api keys only');
    expect(h.runs).toHaveLength(0);
  });

  it('rejects a bad account name', async () => {
    const result = await callHostTool(ctx, tool('server_command'), { server_id: 'srv-1', command: 'id', as: 'root' });
    expect(result.isError).toBe(true);
    expect(h.runs).toHaveLength(0);
  });
});

describe('container_exec', () => {
  beforeEach(() => { h.permissions = new Set(); h.containerRuns.length = 0; });

  it('runs docker exec when the caller holds docker.shell', async () => {
    h.permissions.add('docker.shell');
    const result = await callHostTool(ctx, tool('container_exec'), { server_id: 'srv-1', container: 'web-1', command: 'nginx -t' });
    expect(h.containerRuns[0]).toMatchObject({ serverId: 'srv-1', container: 'web-1', command: 'nginx -t' });
    expect(result.structuredContent).toMatchObject({ exit_code: 0 });
  });

  it('does not run without docker.shell', async () => {
    const result = await callHostTool(ctx, tool('container_exec'), { server_id: 'srv-1', container: 'web-1', command: 'id' });
    expect(result.isError).toBe(true);
    expect(h.containerRuns).toHaveLength(0);
    expect(textOf(result).toLowerCase()).toContain('not permitted');
  });
});

describe('terminal tools', () => {
  beforeEach(() => {
    h.permissions = new Set(); h.requests.length = 0; h.openCalls.length = 0; h.sent.length = 0;
    h.terminalOutput = { output: 'done\n', more: false, password_required: false }; h.closeFound = true;
  });

  it('creates a one-time terminal request without the permission', async () => {
    const result = await callHostTool(ctx, tool('terminal_open'), { server_id: 'srv-1', as: 'service' });
    expect(h.openCalls).toHaveLength(0);
    expect(h.requests[0]).toMatchObject({ kind: 'terminal', serverId: 'srv-1', as: 'service', container: null });
    expect(result.structuredContent).toMatchObject({ request_id: 'req-1' });
  });

  it('opens a session when the caller holds the permission', async () => {
    h.permissions.add('shell.user');
    const result = await callHostTool(ctx, tool('terminal_open'), { server_id: 'srv-1', as: 'user' });
    expect(h.openCalls[0]).toMatchObject({ owner: 'user:u1', serverId: 'srv-1', as: 'user', container: null });
    expect(result.structuredContent).toMatchObject({ session_id: 'sess-1' });
  });

  it('opens a container session as the service account even when as is user', async () => {
    h.permissions.add('docker.shell');
    const result = await callHostTool(ctx, tool('terminal_open'), { server_id: 'srv-1', as: 'user', container: 'web-1' });
    expect(h.openCalls[0]).toMatchObject({ serverId: 'srv-1', as: 'service', container: 'web-1' });
    expect(result.structuredContent).toMatchObject({ as: 'service', container: 'web-1' });
  });

  it('surfaces the password-prompt flag and never the typed input in the result', async () => {
    h.terminalOutput = { output: 'Password: ', more: false, password_required: true };
    const result = await callHostTool(ctx, tool('terminal_send'), { session_id: 'sess-1', input: '{enter}' });
    expect(result.structuredContent).toMatchObject({ password_required: true });
    expect(textOf(result)).toContain('A person must type the password');
  });

  it('reports a missing session on close', async () => {
    h.closeFound = false;
    const result = await callHostTool(ctx, tool('terminal_close'), { session_id: 'gone' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('node-local');
  });
});
