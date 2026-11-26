import { describe, it, expect, vi, afterEach } from 'vitest';
import { bosunVersion, commitTag } from './version';
import { imageRevision, parseImage } from './registry';

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: {}, rowsToObjects: () => [] }));
vi.mock('@/lib/network/node-host', () => ({ detectNodeHost: async () => null, nodeName: () => 'n1', ownContainerIds: () => [] }));

afterEach(() => { vi.unstubAllGlobals(); delete process.env.BOSUN_COMMIT; delete process.env.BOSUN_CHANNEL; });

describe('the version this image was built from', () => {
  it('reads the commit and channel, and says unknown for anything else', () => {
    process.env.BOSUN_COMMIT = 'ABCDEF0123456789abcdef0123456789abcdef01';
    process.env.BOSUN_CHANNEL = 'dev';
    expect(bosunVersion()).toEqual({ commit: 'abcdef0123456789abcdef0123456789abcdef01', short: 'abcdef0', channel: 'dev' });
    process.env.BOSUN_COMMIT = '$(reboot)';
    delete process.env.BOSUN_CHANNEL;
    expect(bosunVersion()).toEqual({ commit: 'unknown', short: 'unknown', channel: 'local' });
    expect(commitTag('abcdef0123456789')).toBe('sha-abcdef0');
  });
});

describe('a node\'s web address', () => {
  it('is the host of its database address with the web port', async () => {
    const { webAddress } = await import('./nodes');
    expect(webAddress('http://192.168.1.130:4001', 3042)).toBe('http://192.168.1.130:3042');
    expect(webAddress('192.168.1.161:4001', 8080)).toBe('http://192.168.1.161:8080');
    expect(webAddress(null, 3042)).toBeNull();
  });
});

describe('which commit an image tag was built from', () => {
  it('accepts registry image names only', () => {
    expect(parseImage('ghcr.io/reallango/bosun')).toEqual({ host: 'ghcr.io', repo: 'reallango/bosun' });
    for (const bad of ['bosun', 'ghcr.io', 'https://ghcr.io/x/y', 'GHCR.io/x/y']) expect(() => parseImage(bad), bad).toThrow();
  });

  it('follows the index to the linux/amd64 image and reads its revision label, with an anonymous token', async () => {
    const seen: string[] = [];
    const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${u} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? '-'}`);
      if (u === 'https://ghcr.io/v2/') return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"' } });
      if (u.startsWith('https://ghcr.io/token')) return json({ token: 'anon' });
      if (u.endsWith('/manifests/dev')) return json({ manifests: [{ digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } }, { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }] }, { 'docker-content-digest': 'sha256:index' });
      if (u.endsWith('/manifests/sha256:amd')) return json({ config: { digest: 'sha256:cfg' } });
      if (u.endsWith('/blobs/sha256:cfg')) return json({ config: { Labels: { 'org.opencontainers.image.revision': 'abcdef0123456789abcdef0123456789abcdef01' } } });
      if (u.endsWith('/manifests/nope')) return new Response('', { status: 404 });
      return new Response('', { status: 500 });
    }));
    expect(await imageRevision('ghcr.io/reallango/bosun', 'dev')).toEqual({ commit: 'abcdef0123456789abcdef0123456789abcdef01', digest: 'sha256:index' });
    expect(seen.find(s => s.includes('/token?'))).toContain('scope=repository%3Areallango%2Fbosun%3Apull');
    expect(seen.filter(s => s.includes('/v2/reallango/')).every(s => s.endsWith('Bearer anon'))).toBe(true);
    expect(await imageRevision('ghcr.io/reallango/bosun', 'nope')).toEqual({ commit: null, digest: null });
  });
});
