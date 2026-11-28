/** `runServerCommand`: the non-admin and service accounts, the same library calls as the REST exec routes, and audit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userRuns: [] as Array<{ command: string; timeoutMs?: number }>,
  serviceRuns: [] as Array<{ command: string; timeoutMs?: number }>,
  audits: [] as Array<Record<string, unknown>>,
  userResult: { stdout: 'user out', stderr: '', exitCode: 0, timedOut: false },
  serviceResult: { stdout: 'root out', stderr: 'warn', exitCode: 3, timedOut: false },
  failService: false,
  rateAllowed: true,
}));

vi.mock('@/lib/ssh/shell-target', () => ({
  loadShellTarget: async () => ({ config: { username: 'deploy', host: 'h', port: 22, privateKey: 'k' }, platform: 'linux' }),
  assertShellAccountSafe: async () => {},
  runOnShellTarget: async (_target: unknown, command: string, opts: { timeoutMs?: number }) => {
    h.userRuns.push({ command, timeoutMs: opts.timeoutMs });
    return h.userResult;
  },
}));
vi.mock('@/lib/ssh/connection-pool', () => ({
  loadServerTarget: async () => ({ config: { username: 'root', host: 'h', port: 22, privateKey: 'k' }, platform: 'linux' }),
  runOnServerId: async (_id: string, command: string, opts: { timeoutMs?: number }) => {
    h.serviceRuns.push({ command, timeoutMs: opts.timeoutMs });
    if (h.failService) throw new Error('ssh down');
    return h.serviceResult;
  },
}));
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>();
  return { ...actual, logAudit: async (entry: Record<string, unknown>) => { h.audits.push(entry); } };
});
vi.mock('@/lib/utils/rate-limiter', () => ({ consumeActionRateLimit: () => ({ allowed: h.rateAllowed }) }));

import { commandRateLimited, runContainerCommand, runServerCommand } from './run-command';

describe('runServerCommand', () => {
  beforeEach(() => {
    h.userRuns.length = 0; h.serviceRuns.length = 0; h.audits.length = 0;
    h.failService = false; h.rateAllowed = true;
  });

  it('runs as the non-admin account for as=user, with the given timeout', async () => {
    const r = await runServerCommand({ serverId: 'srv-1', command: '  uptime  ', as: 'user', timeoutMs: 5_000, userId: 'u1', ip: '10.0.0.1' });
    expect(h.userRuns).toEqual([{ command: 'uptime', timeoutMs: 5_000 }]);
    expect(h.serviceRuns).toHaveLength(0);
    expect(r).toMatchObject({ stdout: 'user out', stderr: '', exitCode: 0, as: 'user', account: 'deploy' });
    expect(h.audits[0]).toMatchObject({ action: 'server.shell_exec', status: 'success', serverId: 'srv-1', userId: 'u1' });
    expect(String(h.audits[0].details)).toContain('deploy: uptime');
  });

  it('runs as the service account for as=service', async () => {
    const r = await runServerCommand({ serverId: 'srv-1', command: 'id', as: 'service', timeoutMs: 1_000, userId: 'u1' });
    expect(h.serviceRuns).toEqual([{ command: 'id', timeoutMs: 1_000 }]);
    expect(h.userRuns).toHaveLength(0);
    expect(r).toMatchObject({ stdout: 'root out', stderr: 'warn', exitCode: 3, as: 'service', account: 'root' });
    expect(h.audits[0]).toMatchObject({ action: 'server.exec', status: 'failure' });
  });

  it('records the approver and request on an approved run', async () => {
    await runServerCommand({ serverId: 'srv-1', command: 'id', as: 'user', userId: 'u1', approvedBy: 'admin', requestId: 'req-1' });
    expect(String(h.audits[0].details)).toContain('approved by admin (request req-1)');
  });

  it('rejects an empty or over-long command before connecting', async () => {
    await expect(runServerCommand({ serverId: 'srv-1', command: '  ', as: 'user' })).rejects.toMatchObject({ code: 'COMMAND_REQUIRED' });
    await expect(runServerCommand({ serverId: 'srv-1', command: 'x'.repeat(4001), as: 'user' })).rejects.toMatchObject({ code: 'COMMAND_TOO_LONG' });
    expect(h.userRuns).toHaveLength(0);
  });

  it('audits a failure and rethrows it', async () => {
    h.failService = true;
    await expect(runServerCommand({ serverId: 'srv-1', command: 'id', as: 'service' })).rejects.toThrow('ssh down');
    expect(h.audits[0]).toMatchObject({ action: 'server.exec', status: 'failure' });
  });
});

describe('runContainerCommand', () => {
  beforeEach(() => { h.serviceRuns.length = 0; h.audits.length = 0; h.failService = false; });

  it('runs docker exec with the container name quoted', async () => {
    const r = await runContainerCommand({ serverId: 'srv-1', container: 'web-1', command: 'nginx -t' });
    expect(h.serviceRuns[0].command).toBe("docker exec 'web-1' nginx -t");
    expect(r.as).toBe('service');
  });

  it('refuses an invalid container name', async () => {
    await expect(runContainerCommand({ serverId: 'srv-1', container: "x'; rm -rf /", command: 'id' })).rejects.toMatchObject({ code: 'INVALID_CONTAINER' });
    expect(h.serviceRuns).toHaveLength(0);
  });
});

describe('command rate limit', () => {
  it('reports the shared action rate limit', () => {
    h.rateAllowed = false;
    expect(commandRateLimited('u1')).toBe(true);
    h.rateAllowed = true;
    expect(commandRateLimited('u1')).toBe(false);
  });
});
