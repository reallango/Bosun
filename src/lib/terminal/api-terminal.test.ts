import { describe, it, expect } from 'vitest';
import {
  checkApiTerminalClaims, checkWebCommandClaims, isValidTerminalCommand, UsedTokens, SessionLimiter,
  TOKEN_TYPE, WEB_CMD_TOKEN_TYPE, terminalLimits, LIMIT_KEYS,
} from './api-terminal';

const goodHost = { type: TOKEN_TYPE, authType: 'api_key', userId: 'apikey:k1', serverId: 's1', jti: 'j1', target: 'host' };
const goodCommand = { ...goodHost, target: 'command', cmd: "docker exec -it abc sh -c 'exec sh'", label: 'Shell: web' };

describe('checkApiTerminalClaims', () => {
  it('accepts well-formed API key tokens', () => {
    expect(checkApiTerminalClaims(goodHost).ok).toBe(true);
    expect(checkApiTerminalClaims(goodCommand).ok).toBe(true);
  });
  it('rejects the web terminal token type, sessions, and malformed claims', () => {
    expect(checkApiTerminalClaims({ ...goodHost, type: 'ws' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, authType: 'session' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, userId: 'u1' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, jti: undefined }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'root' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, target: 'container', container: 'web' }).ok).toBe(false);
    expect(checkApiTerminalClaims(null).ok).toBe(false);
  });
  it('a command token needs a command and a label, a host token must not carry them', () => {
    expect(checkApiTerminalClaims({ ...goodCommand, cmd: undefined }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodCommand, label: undefined }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodCommand, cmd: 'echo hi\nid' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodCommand, cmd: 'x'.repeat(2001) }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, cmd: 'id' }).ok).toBe(false);
    expect(checkApiTerminalClaims({ ...goodHost, label: 'x' }).ok).toBe(false);
  });
});

describe('checkWebCommandClaims', () => {
  const access = { userId: 'u1', role: 'admin' };
  const good = { type: WEB_CMD_TOKEN_TYPE, userId: 'u1', serverId: 's1', jti: 'j1', cmd: 'docker exec -it abc sh', label: 'Shell: web' };
  it('accepts a command token minted for this user', () => {
    expect(checkWebCommandClaims(good, access).ok).toBe(true);
  });
  it('refuses another user, another token type, API keys and malformed claims', () => {
    expect(checkWebCommandClaims({ ...good, userId: 'u2' }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, type: 'ws' }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, type: TOKEN_TYPE }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, authType: 'api_key' }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, userId: 'apikey:k' }, { userId: 'apikey:k' }).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, jti: undefined }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, serverId: '' }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, cmd: '' }, access).ok).toBe(false);
    expect(checkWebCommandClaims({ ...good, label: 'a\nb' }, access).ok).toBe(false);
    expect(checkWebCommandClaims(null, access).ok).toBe(false);
    expect(checkWebCommandClaims(good, null).ok).toBe(false);
  });
});

describe('isValidTerminalCommand', () => {
  it('is one non-empty line of limited length without control characters', () => {
    expect(isValidTerminalCommand('docker exec -it abc sh')).toBe(true);
    for (const bad of ['', 'a\nb', 'a\u0000b', 'a\u007fb', 'x'.repeat(2001), 5, null, undefined]) expect(isValidTerminalCommand(bad as never), String(bad)).toBe(false);
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

describe('terminalLimits', () => {
  it('uses the defaults when nothing is set', () => {
    const l = terminalLimits({});
    expect(l.tokenTtlSec).toBe(60);
    expect(l.maxPerKey).toBe(3);
  });
  it('applies configured values, clamped to sane ranges, and ignores junk', () => {
    expect(terminalLimits({ [LIMIT_KEYS.tokenTtlSec]: '30' }).tokenTtlSec).toBe(30);
    expect(terminalLimits({ [LIMIT_KEYS.tokenTtlSec]: '1' }).tokenTtlSec).toBe(10);
    expect(terminalLimits({ [LIMIT_KEYS.tokenTtlSec]: '99999' }).tokenTtlSec).toBe(300);
    expect(terminalLimits({ [LIMIT_KEYS.maxPerKey]: 'lots' }).maxPerKey).toBe(3);
  });
  it('lets the session limiter take a per-call cap', () => {
    const l = new SessionLimiter(1);
    expect(l.acquire('k', 2)).toBe(true);
    expect(l.acquire('k', 2)).toBe(true);
    expect(l.acquire('k', 2)).toBe(false);
  });
});
