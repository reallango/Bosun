import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveClientIp, clientIpFromHeaders, splitEntries, refreshNames, resolvedNames, _setLookupForTests } from './client-ip';

const saved = process.env.TRUSTED_PROXIES;
afterEach(() => { if (saved === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = saved; });

describe('client IP', () => {
  it('uses the connecting address and ignores X-Forwarded-For when no proxy is trusted', () => {
    delete process.env.TRUSTED_PROXIES;
    expect(resolveClientIp('192.168.1.20', '1.2.3.4')).toBe('192.168.1.20');
    expect(resolveClientIp('::ffff:192.168.1.20', undefined)).toBe('192.168.1.20');
    expect(resolveClientIp('', '1.2.3.4')).toBe('unknown');
  });

  it('a forged X-Bosun-Peer is impossible through nginx, and without it the socket address counts', () => {
    delete process.env.TRUSTED_PROXIES;
    const h = (m: Record<string, string>) => (n: string) => m[n];
    expect(clientIpFromHeaders(h({ 'x-bosun-peer': '10.0.0.5', 'x-forwarded-for': '6.6.6.6' }))).toBe('10.0.0.5');
    expect(clientIpFromHeaders(h({}), '10.0.0.9')).toBe('10.0.0.9');
  });

  it('behind a trusted proxy, the rightmost untrusted X-Forwarded-For address is the client', () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16, 10.0.0.1';
    // the client put 6.6.6.6 in the header itself; the proxy appended the real address
    expect(resolveClientIp('172.18.0.7', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    // a chain of trusted proxies is skipped
    expect(resolveClientIp('172.18.0.7', '203.0.113.9, 10.0.0.1')).toBe('203.0.113.9');
    // a trusted proxy that sends no header: the proxy itself
    expect(resolveClientIp('172.18.0.7', undefined)).toBe('172.18.0.7');
    // junk entries are ignored
    expect(resolveClientIp('172.18.0.7', 'not-an-ip, 198.51.100.4')).toBe('198.51.100.4');
    // an untrusted peer's header is never read
    expect(resolveClientIp('192.168.1.50', '203.0.113.9')).toBe('192.168.1.50');
  });
});

describe('trusted proxies by name (e.g. a container on the same Docker network)', () => {
  type Row = { address: string; family: number };
  const dnsWith = (table: Record<string, string[] | Error>) => async (name: string): Promise<Row[]> => {
    const v = table[name];
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return v.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }));
  };
  afterEach(() => _setLookupForTests(null));

  it('splits addresses, CIDRs and names, and ignores junk', () => {
    expect(splitEntries(' 10.0.0.1, 172.18.0.0/16, cloudflared, proxy.lan, ::1, bad name, -x, 1.2.3, cf/24 ')).toEqual({
      addresses: ['10.0.0.1', '172.18.0.0/16', '::1'],
      names: ['cloudflared', 'proxy.lan'],
    });
  });

  it('trusts a name once it has resolved, and follows it when the container gets a new address', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const table: Record<string, string[] | Error> = { cloudflared: ['172.18.0.5'] };
    _setLookupForTests(dnsWith(table));
    process.env.TRUSTED_PROXIES = 'cloudflared';
    // not resolved yet: nothing is trusted, the peer is the client
    expect(resolveClientIp('172.18.0.5', '203.0.113.9')).toBe('172.18.0.5');
    await refreshNames();
    expect(resolvedNames()).toEqual({ cloudflared: ['172.18.0.5'] });
    expect(resolveClientIp('172.18.0.5', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    // any other container on the network is not trusted
    expect(resolveClientIp('172.18.0.6', '203.0.113.9')).toBe('172.18.0.6');
    // recreated with a new address
    table.cloudflared = ['172.18.0.9'];
    await refreshNames();
    expect(resolveClientIp('172.18.0.5', '203.0.113.9')).toBe('172.18.0.5');
    expect(resolveClientIp('172.18.0.9', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('keeps the last addresses on a passing DNS error, and drops them when the name is gone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const table: Record<string, string[] | Error> = { cloudflared: ['172.18.0.5'] };
    _setLookupForTests(dnsWith(table));
    process.env.TRUSTED_PROXIES = 'cloudflared, 10.0.0.1';
    resolveClientIp('1.1.1.1', undefined);
    await refreshNames();
    table.cloudflared = Object.assign(new Error('try again'), { code: 'EAI_AGAIN' });
    await refreshNames();
    expect(resolveClientIp('172.18.0.5', '203.0.113.9')).toBe('203.0.113.9');
    delete table.cloudflared; // ENOTFOUND
    await refreshNames();
    expect(resolveClientIp('172.18.0.5', '203.0.113.9')).toBe('172.18.0.5');
    // literal entries are unaffected by name lookups
    expect(resolveClientIp('10.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
  });
});