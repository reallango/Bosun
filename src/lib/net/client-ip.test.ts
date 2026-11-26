import { describe, it, expect, afterEach } from 'vitest';
import { resolveClientIp, clientIpFromHeaders } from './client-ip';

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
