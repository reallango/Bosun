import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/widgets/package-routes', () => ({
  requirePackageAdmin: async () => ({ userId: 'u1' }),
  configuredRef: async () => 'main',
}));
vi.mock('@/lib/widgets/package-store', () => ({
  listInstalledPackages: async () => [],
  sameOrigin: () => true,
}));
vi.mock('@/lib/widgets/package-secrets', () => ({ packageSecretStatus: async () => ({}) }));

import { GET } from './route';

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  schema: 1, id, name: id.toUpperCase(), version: '1.0.0',
  widgets: [{ type: `${id}_w`, display_name: id }],
  ...extra,
});

/** A fake GitHub with `widgets/<id>/manifest.json` for each id. */
function fakeGithub(manifests: Record<string, unknown>) {
  const files = Object.fromEntries(Object.entries(manifests).map(([id, raw]) => [`widgets/${id}/manifest.json`, JSON.stringify(raw)]));
  return async (url: string) => {
    const respond = (status: number, body = '') => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => body });
    const api = url.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]*)\?ref=/);
    if (api) {
      const dir = decodeURIComponent(api[1]);
      const children = new Set<string>();
      let dirs = 0;
      for (const p of Object.keys(files)) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1);
        children.add(rest.split('/')[0]);
        if (rest.includes('/')) dirs++;
      }
      if (!children.size) return respond(404);
      return respond(200, JSON.stringify(Array.from(children).map(name => ({
        name, type: dirs ? 'dir' : 'file', path: `${dir}/${name}`,
      }))));
    }
    const rawPath = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/);
    if (rawPath && files[rawPath[1] as keyof typeof files] !== undefined) return respond(200, files[rawPath[1] as keyof typeof files]);
    return respond(404);
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/widget-packages/available and the widget API level', () => {
  it('lists a package that needs a newer Bosun as not installable, with the reason', async () => {
    vi.stubGlobal('fetch', fakeGithub({
      future: manifest('future', { requires: { api: 99 } }),
      current: manifest('current', { requires: { api: 3 } }),
      plain: manifest('plain'),
    }));
    const res = await GET(new NextRequest('http://localhost/api/widget-packages/available?refresh=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map(body.data.packages.map((p: { id: string }) => [p.id, p]));
    expect(byId.get('future')).toMatchObject({
      installable: false,
      blockedReason: 'This widget needs a newer Bosun (widget API level 99; this Bosun has 4). Update Bosun first.',
    });
    expect(byId.get('current')).toMatchObject({ installable: true, blockedReason: null });
    expect(byId.get('plain')).toMatchObject({ installable: true, blockedReason: null });
  });
});
