/** `runServerCommand`: the non-admin and service accounts, the same library calls as the REST exec routes, and audit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  userRuns: [] as Array<{ command: string; timeoutMs?: number }>,
  serviceRuns: [] as Array<{ command: string; timeoutMs?: number }>,
  audits: [] as Array<Record<string, unknown>>,
  userResult: { stdout: 'user out', stderr: '', exitCode: 0, timedOut: false },
  serviceResult: { stdout: 'root out', stderr: 'warn', exitCode: 3, timedOut: false },
  platform: 'linux' as 'linux' | 'windows',
  failService: false,
  rateAllowed: true,
}));

vi.mock('@/lib/ssh/shell-target', () => ({
  loadShellTarget: async () => ({ config: { username: 'deploy', host: 'h', port: 22, privateKey: 'k' }, platform: h.platform }),
  assertShellAccountSafe: async () => {},
  runOnShellTarget: async (_target: unknown, command: string, opts: { timeoutMs?: number }) => {
    h.userRuns.push({ command, timeoutMs: opts.timeoutMs });
    return h.userResult;
  },
}));
vi.mock('@/lib/ssh/connection-pool', () => ({
  loadServerTarget: async () => ({ config: { username: 'root', host: 'h', port: 22, privateKey: 'k' }, platform: h.platform }),
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

import { commandRateLimited, runContainerCommand, runServerCommand, withRemoteTimeout } from './run-command';

describe('runServerCommand', () => {
  beforeEach(() => {
    h.userRuns.length = 0; h.serviceRuns.length = 0; h.audits.length = 0;
    h.failService = false; h.rateAllowed = true; h.platform = 'linux';
  });

  it('runs as the non-admin account for as=user, with the given timeout', async () => {
    const r = await runServerCommand({ serverId: 'srv-1', command: '  uptime  ', as: 'user', timeoutMs: 5_000, userId: 'u1', ip: '10.0.0.1' });
    expect(h.userRuns).toHaveLength(1);
    expect(h.userRuns[0].timeoutMs).toBe(5_000);
    expect(h.userRuns[0].command).toContain(`timeout -k 5 5 sh -c 'uptime'`);
    expect(h.serviceRuns).toHaveLength(0);
    expect(r).toMatchObject({ stdout: 'user out', stderr: '', exitCode: 0, as: 'user', account: 'deploy' });
    expect(h.audits[0]).toMatchObject({ action: 'server.shell_exec', status: 'success', serverId: 'srv-1', userId: 'u1' });
    expect(String(h.audits[0].details)).toContain('deploy: uptime');
  });

  it('runs as the service account for as=service', async () => {
    const r = await runServerCommand({ serverId: 'srv-1', command: 'id', as: 'service', timeoutMs: 1_000, userId: 'u1' });
    expect(h.serviceRuns).toHaveLength(1);
    expect(h.serviceRuns[0].timeoutMs).toBe(1_000);
    expect(h.serviceRuns[0].command).toContain(`timeout -k 5 1 sh -c 'id'`);
    expect(h.userRuns).toHaveLength(0);
    expect(r).toMatchObject({ stdout: 'root out', stderr: 'warn', exitCode: 3, as: 'service', account: 'root' });
    expect(h.audits[0]).toMatchObject({ action: 'server.exec', status: 'failure' });
  });

  it('reports a run stopped by the remote timeout as timed out', async () => {
    h.serviceResult = { stdout: '', stderr: '', exitCode: 124, timedOut: false };
    const r = await runServerCommand({ serverId: 'srv-1', command: 'sleep 20', as: 'service', timeoutMs: 3_000 });
    expect(r.timedOut).toBe(true);
  });

  it('leaves a Windows command unwrapped', async () => {
    h.platform = 'windows';
    await runServerCommand({ serverId: 'srv-1', command: 'Get-Process', as: 'service', timeoutMs: 3_000 });
    expect(h.serviceRuns[0].command).toBe('Get-Process');
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
  beforeEach(() => { h.serviceRuns.length = 0; h.audits.length = 0; h.failService = false; h.platform = 'linux'; h.serviceResult = { stdout: 'root out', stderr: 'warn', exitCode: 3, timedOut: false }; });

  it('runs the command in a shell inside the container, not in the host shell', async () => {
    const r = await runContainerCommand({ serverId: 'srv-1', container: 'web-1', command: 'nginx -t' });
    expect(h.serviceRuns[0].command).toContain(`docker exec '\\''web-1'\\'' sh -c '\\''nginx -t'\\''`);
    expect(h.serviceRuns[0].command).not.toMatch(/docker exec 'web-1' nginx/);
    expect(r.as).toBe('service');
  });

  it('refuses an invalid container name', async () => {
    await expect(runContainerCommand({ serverId: 'srv-1', container: "x'; rm -rf /", command: 'id' })).rejects.toMatchObject({ code: 'INVALID_CONTAINER' });
    expect(h.serviceRuns).toHaveLength(0);
  });

  it('reports a container without a POSIX shell instead of running anything on the host', async () => {
    h.serviceResult = { stdout: '', stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown', exitCode: 126, timedOut: false };
    await expect(runContainerCommand({ serverId: 'srv-1', container: 'distroless', command: 'id' }))
      .rejects.toMatchObject({ code: 'CONTAINER_NO_SHELL' });
    expect(h.serviceRuns[0].command).toContain('sh -c');
  });

  // The host command is executed with a real shell and a `docker` that only prints its arguments: whatever the caller
  // sends must reach `docker` as one argument and must not run on the host.
  describe('host command injection', () => {
    const payloads = [
      'true; id; hostname',
      'id && hostname',
      'echo $(id)',
      'echo `id`',
      'echo one\ntouch CANARY',
      'cat /etc/hostname | id',
      "echo '; id;'",
    ];

    function harness() {
      const dir = mkdtempSync(path.join(tmpdir(), 'bosun-exec-'));
      const bin = path.join(dir, 'bin');
      execFileSync('mkdir', ['-p', bin]);
      writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n--\\n\' "$a"; done\n');
      chmodSync(path.join(bin, 'docker'), 0o755);
      return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
    }

    /** The arguments the fake `docker` received (each printed as `<arg>\\n--\\n`). */
    function argvOf(stdout: string): string[] {
      const parts = stdout.split('\n--\n');
      if (parts[parts.length - 1] === '') parts.pop();
      return parts;
    }

    for (const payload of payloads) {
      it(`passes ${JSON.stringify(payload)} to the container as one argument`, async () => {
        h.serviceRuns.length = 0;
        h.serviceResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        await runContainerCommand({ serverId: 'srv-1', container: 'web-1', command: payload });
        const { dir, env } = harness();
        const stdout = execFileSync('sh', ['-c', h.serviceRuns[0].command], { cwd: dir, env, encoding: 'utf8' });
        expect(argvOf(stdout)).toEqual(['exec', 'web-1', 'sh', '-c', payload]);
        expect(existsSync(path.join(dir, 'CANARY'))).toBe(false);
        expect(stdout).not.toContain('uid=');
      });
    }

    it('also sends a payload that tries to close the quote as one argument', async () => {
      h.serviceRuns.length = 0;
      h.serviceResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      const payload = `x'; id; echo '`;
      await runContainerCommand({ serverId: 'srv-1', container: 'web-1', command: payload });
      const { dir, env } = harness();
      const stdout = execFileSync('sh', ['-c', h.serviceRuns[0].command], { cwd: dir, env, encoding: 'utf8' });
      expect(argvOf(stdout)).toEqual(['exec', 'web-1', 'sh', '-c', payload]);
      expect(stdout).not.toContain('uid=');
    });
  });
});

describe('withRemoteTimeout', () => {
  it('wraps a POSIX command so the remote shell stops it, and keeps the command as one argument', () => {
    const wrapped = withRemoteTimeout('linux', 'sleep 20; id', 3_000);
    expect(wrapped).toContain('timeout -k 5 3 sh -c');
    expect(wrapped).toContain(`'sleep 20; id'`);
  });

  it('does not wrap a Windows command', () => {
    expect(withRemoteTimeout('windows', 'Get-Process', 3_000)).toBe('Get-Process');
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
