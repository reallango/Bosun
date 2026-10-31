import { describe, it, expect, beforeEach } from 'vitest';
import { safeLookup, isPrivateAddress, checkLookupUrl, valueAtPath, applyMatch, performLookup, loadLookups, clearLookupCache, LookupError, type Transport } from './lookups';

const spec = { url: 'https://api.example.com/repos/x/releases/latest', path: 'tag_name', match: '^v(\\d+\\.\\d+\\.\\d+)$', ttlSec: 600 };
const answer = (body: unknown, status = 200): Transport => async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('addresses a lookup may not use', () => {
  it('refuses loopback, private, link-local, shared, reserved and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.171', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not an ip']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });
  it('accepts public addresses', () => {
    for (const a of ['140.82.112.5', '8.8.8.8', '172.32.0.1', '172.15.255.255', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('which URLs are allowed', () => {
  const hosts = ['api.example.com'];
  it('accepts an https URL on a declared host', () => {
    expect(checkLookupUrl('https://api.example.com/a?b=1', hosts).hostname).toBe('api.example.com');
    expect(checkLookupUrl('https://API.example.com/a', hosts).hostname).toBe('api.example.com');
  });
  it('refuses everything else', () => {
    for (const u of ['http://api.example.com/a', 'https://other.example.com/a', 'https://api.example.com:8443/a', 'https://user:pw@api.example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'ftp://api.example.com/a', 'nonsense', 'https://api.example.com.evil.com/a']) {
      expect(() => checkLookupUrl(u, hosts), u).toThrow(LookupError);
    }
  });
});

describe('reading the answer', () => {
  it('follows a dotted path, with array indexes, and only returns scalars', () => {
    const j = { tag_name: 'v1.2.3', n: 5, ok: true, list: [{ v: 'a' }, { v: 'b' }], obj: { x: 1 } };
    expect(valueAtPath(j, 'tag_name')).toBe('v1.2.3');
    expect(valueAtPath(j, 'n')).toBe('5');
    expect(valueAtPath(j, 'ok')).toBe('true');
    expect(valueAtPath(j, 'list.1.v')).toBe('b');
    expect(valueAtPath(j, 'obj')).toBeNull();
    expect(valueAtPath(j, 'missing')).toBeNull();
    expect(valueAtPath(j, 'list.x')).toBeNull();
    expect(valueAtPath(j, 'tag_name.deeper')).toBeNull();
    expect(valueAtPath(j, '__proto__.polluted')).toBeNull();
  });
  it('applies the capture group', () => {
    expect(applyMatch('v1.2.3', '^v(\\d+\\.\\d+\\.\\d+)$')).toBe('1.2.3');
    expect(applyMatch('nightly', '^v(\\d+\\.\\d+\\.\\d+)$')).toBeNull();
    expect(applyMatch('v1', undefined)).toBe('v1');
  });
});

describe('performLookup', () => {
  const hosts = ['api.example.com'];
  it('returns the matched value', async () => {
    expect(await performLookup(spec, hosts, answer({ tag_name: 'v0.9.1' }))).toBe('0.9.1');
  });
  it('gives null when the answer has no such value', async () => {
    expect(await performLookup(spec, hosts, answer({ other: 1 }))).toBeNull();
    expect(await performLookup(spec, hosts, answer({ tag_name: 'nightly' }))).toBeNull();
  });
  it('refuses redirects, errors, non-JSON and undeclared hosts', async () => {
    await expect(performLookup(spec, hosts, answer('', 302))).rejects.toThrow(/redirect/);
    await expect(performLookup(spec, hosts, answer({}, 404))).rejects.toThrow(/404/);
    await expect(performLookup(spec, hosts, answer('<html>'))).rejects.toThrow(/not JSON/);
    await expect(performLookup(spec, ['else.example.com'], answer({}))).rejects.toThrow(/network access/);
    await expect(performLookup(spec, hosts, async () => { throw new Error('ECONNRESET'); })).rejects.toThrow(/ECONNRESET/);
  });
  it('the real transport never connects to a name that resolves to a local address', async () => {
    await expect(performLookup({ url: 'https://localhost/x', path: 'a', ttlSec: 60 }, ['localhost'])).rejects.toThrow(/address that lookups may not use|failed/);
  });
});

describe('loadLookups', () => {
  beforeEach(() => clearLookupCache());
  const hosts = ['api.example.com'];

  it('caches a value for its ttl', async () => {
    let calls = 0;
    const t: Transport = async () => { calls++; return { status: 200, body: JSON.stringify({ tag_name: `v1.0.${calls}` }) }; };
    expect(await loadLookups('pkg', { latest: spec }, hosts, t, 1000)).toEqual({ latest: '1.0.1' });
    expect(await loadLookups('pkg', { latest: spec }, hosts, t, 1000 + 599_000)).toEqual({ latest: '1.0.1' });
    expect(calls).toBe(1);
    expect(await loadLookups('pkg', { latest: spec }, hosts, t, 1000 + 601_000)).toEqual({ latest: '1.0.2' });
  });

  it('a failure gives null, is remembered briefly, and keeps the last good value', async () => {
    let fail = false; let calls = 0;
    const t: Transport = async () => { calls++; if (fail) throw new Error('down'); return { status: 200, body: JSON.stringify({ tag_name: 'v2.0.0' }) }; };
    expect(await loadLookups('p2', { latest: spec }, hosts, t, 0)).toEqual({ latest: '2.0.0' });
    fail = true;
    expect(await loadLookups('p2', { latest: spec }, hosts, t, 700_000)).toEqual({ latest: '2.0.0' });   // expired, failed, last value kept
    expect(await loadLookups('p2', { latest: spec }, hosts, t, 710_000)).toEqual({ latest: '2.0.0' });   // within the failure delay: no new request
    expect(calls).toBe(2);
    expect(await loadLookups('p3', { latest: spec }, hosts, async () => { throw new Error('x'); }, 0)).toEqual({ latest: null });
  });

  it('handles a package without lookups', async () => {
    expect(await loadLookups('p4', undefined, hosts)).toEqual({});
  });
});

describe('the connection-time address check', () => {
  const call = (host: string, all: boolean) => new Promise<{ err: Error | null; address?: unknown; family?: number }>(resolve =>
    safeLookup(host, all ? { all: true } : {}, (err, address, family) => resolve({ err, address, family })));

  it('answers an array when Node asks for all addresses, one address otherwise', async () => {
    const many = await call('8.8.8.8', true);
    expect(many.err).toBeNull();
    expect(many.address).toEqual([{ address: '8.8.8.8', family: 4 }]);
    const one = await call('8.8.8.8', false);
    expect(one.err).toBeNull();
    expect(one.address).toBe('8.8.8.8');
    expect(one.family).toBe(4);
  });

  it('refuses a name or address that is local, in both modes', async () => {
    for (const all of [true, false]) {
      expect((await call('localhost', all)).err).toBeInstanceOf(LookupError);
      expect((await call('127.0.0.1', all)).err).toBeInstanceOf(LookupError);
      expect((await call('192.168.1.171', all)).err).toBeInstanceOf(LookupError);
    }
  });
});
