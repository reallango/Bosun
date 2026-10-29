import { describe, it, expect } from 'vitest';
import {
  checkApiTerminalClaims, UsedTokens, SessionLimiter, containerRisks, isSensitiveMount, parseInspect,
  inspectCommand, dockerExecCommand, TOKEN_TYPE,
} from './api-terminal';

const goodHost = { type: TOKEN_TYPE, authType: 'api_key', userId: 'apikey:k1', serverId: 's1', jti: 'j1', target: 'host' };
const ID = 'a'.repeat(64);

const safe = () => ({ Id: ID, State: { Running: true }, HostConfig: { Privileged: false, PidMode: '', CapAdd: null, Devices: null, SecurityOpt: null, Binds: ['/srv/app:/data'] },
  Mounts: [{ Type: 'bind', Source: '/srv/app', Destination: '/data' }, { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data' }] });

describe('checkApiTerminalClaims', () => {
  it('accepts well-formed API key tokens', () => {
    expect(checkApiTerminalClaims(goodHost).ok).toBe(true);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'container', container: 'web-1' }).ok).toBe(true);
  });
  it('rejects the web terminal token type, sessions, and malformed claims', () => {
    expect(checkApiTerminalClaims({ ...goodHost, type: 'ws' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, authType: 'session' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, userId: 'u1' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, jti: undefined }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'root' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'container', container: '--privileged' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'container', container: 'a b' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, container: 'web' }).ok).toBe(false);
    expect(checkApiTerminalClaims(null).ok).toBe(false);
  });
});

describe('UsedTokens and SessionLimiter', () => {
  it('makes tokens single use', () => {
    const u = new UsedTokens();
    expect(u.consume('a', 2, 1000)).toBe(true);
    expect(u.consume('a', 2, 1500)).toBe(false);
    expect(u.consume('a', 2, 5000)).toBe(true); // forgotten once it would have expired
  });
  it('caps concurrent sessions per key', () => {
    const l = new SessionLimiter(2);
    expect(l.acquire('k')).toBe(true);
    expect(l.acquire('k')).toBe(true);
    expect(l.acquire('k')).toBe(false);
    expect(l.acquire('other')).toBe(true);
    l.release('k');
    expect(l.acquire('k')).toBe(true);
  });
});

describe('containerRisks', () => {
  it('accepts an ordinary container', () => {
    expect(containerRisks(safe())).toEqual([]);
  });
  it('refuses anything that reaches the host', () => {
    const cases: [string, (c: any) => void, RegExp][] = [
      ['privileged', c => { c.HostConfig.Privileged = true; }, /privileged/],
      ['host pid', c => { c.HostConfig.PidMode = 'host'; }, /PID/],
      ['host ipc', c => { c.HostConfig.IpcMode = 'host'; }, /IPC/],
      ['sys_admin', c => { c.HostConfig.CapAdd = ['CAP_SYS_ADMIN']; }, /capabilities/],
      ['devices', c => { c.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; }, /devices/],
      ['unconfined', c => { c.HostConfig.SecurityOpt = ['seccomp=unconfined']; }, /security profile/],
      ['docker socket', c => { c.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock' }); }, /mounts/],
      ['root fs', c => { c.Mounts.push({ Type: 'bind', Source: '/' }); }, /mounts/],
      ['etc', c => { c.Mounts.push({ Type: 'bind', Source: '/etc/ssh' }); }, /mounts/],
      ['home', c => { c.HostConfig.Binds = ['/home/admin/.ssh:/k:ro']; }, /mounts/],
      ['traversal', c => { c.Mounts.push({ Type: 'bind', Source: '/srv/../etc' }); }, /mounts/],
      ['stopped', c => { c.State.Running = false; }, /not running/],
    ];
    for (const [name, mutate, re] of cases) {
      const c = safe();
      mutate(c);
      const r = containerRisks(c);
      expect(r.length, name).toBeGreaterThan(0);
      expect(r.join(' '), name).toMatch(re);
    }
  });
  it('treats unreadable inspections as unsafe', () => {
    expect(containerRisks(null).length).toBe(1);
    expect(containerRisks({}).length).toBe(1);
    expect(parseInspect('not json')).toBeNull();
    expect(parseInspect('[]')).toBeNull();
    expect(parseInspect(JSON.stringify([safe(), safe()]))).toBeNull();
    expect(parseInspect(JSON.stringify([safe()]))?.Id).toBe(ID);
  });
  it('knows which mount sources are sensitive', () => {
    for (const s of ['/', '/etc', '/etc/shadow', '/root', '/home/me', '/run/docker.sock', '/var/run', '/proc/1', '/srv/../etc', '/opt/x/docker.sock']) expect(isSensitiveMount(s), s).toBe(true);
    for (const s of ['/srv/app', '/mnt/data', '/opt/app', '/var/lib/myapp', '/homework']) expect(isSensitiveMount(s), s).toBe(false);
  });
});

describe('commands', () => {
  it('only builds fixed docker commands from validated input', () => {
    expect(inspectCommand('web-1')).toBe('docker inspect --type container web-1');
    expect(() => inspectCommand('x; reboot')).toThrow();
    expect(() => inspectCommand('--privileged')).toThrow();
    expect(dockerExecCommand(ID)).toBe(`docker exec -it ${ID} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'`);
    expect(() => dockerExecCommand('web-1')).toThrow();
    expect(() => dockerExecCommand(ID + '; id')).toThrow();
  });
});
