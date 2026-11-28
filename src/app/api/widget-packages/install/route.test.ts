import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const install = vi.hoisted(() => vi.fn());
const clusterProblem = vi.hoisted(() => vi.fn());

vi.mock('@/lib/widgets/package-routes', () => ({
  requirePackageAdmin: async () => ({ userId: 'u1' }),
  configuredRef: async () => 'main',
  requestIp: () => '127.0.0.1',
}));
vi.mock('@/lib/audit/logger', () => ({
  logAudit: async () => undefined,
  AuditActions: { WIDGET_PACKAGE_INSTALL: 'widget_package.install' },
}));
vi.mock('@/lib/widgets/package-store', () => ({ installPackage: install }));
vi.mock('@/lib/widgets/cluster-level', () => ({ clusterInstallProblem: clusterProblem }));

import { POST } from './route';
import { manifestHashOf } from '@/lib/widgets/package-source';
import { validateManifest } from '@/lib/widgets/package-manifest';

const manifest = (extra: Record<string, unknown> = {}) => ({
  schema: 1, id: 'alpha', name: 'Alpha', version: '1.0.0',
  widgets: [{ type: 'alpha_w', display_name: 'Alpha' }],
  ...extra,
});

/** A fake GitHub with just `widgets/alpha/manifest.json`. */
function fakeGithub(raw: unknown) {
  const files = { 'widgets/alpha/manifest.json': JSON.stringify(raw) };
  return async (url: string) => {
    const respond = (status: number, body = '') => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => body });
    const api = url.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]*)\?ref=/);
    if (api) {
      const dir = decodeURIComponent(api[1]);
      if (!Object.keys(files).some(p => p.startsWith(`${dir}/`))) return respond(404);
      return respond(200, JSON.stringify([{ name: 'manifest.json', type: 'file', path: `${dir}/manifest.json` }]));
    }
    const rawPath = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/);
    if (rawPath && files[rawPath[1] as keyof typeof files] !== undefined) return respond(200, files[rawPath[1] as keyof typeof files]);
    return respond(404);
  };
}

const hashOf = (raw: unknown): string => {
  const v = validateManifest(raw);
  if (!v.ok) throw new Error(v.error);
  return manifestHashOf(v.value);
};

const installRequest = (manifestHash: string) => POST(new NextRequest('http://localhost/api/widget-packages/install', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'alpha', version: '1.0.0', manifestHash }),
}));

beforeEach(() => {
  clusterProblem.mockReset().mockResolvedValue(null);
  install.mockReset().mockResolvedValue({
    id: 'alpha', version: '1.0.0', previousVersion: null, widgetTypes: ['alpha_w'], permissions: [], secretsCleared: false,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /api/widget-packages/install and the widget API level', () => {
  it('refuses a package that needs a newer Bosun (install or upgrade from GitHub)', async () => {
    vi.stubGlobal('fetch', fakeGithub(manifest({ requires: { api: 99 } })));
    const res = await installRequest('a'.repeat(64));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe('This widget needs a newer Bosun (widget API level 99; this Bosun has 9). Update Bosun first.');
    expect(install).not.toHaveBeenCalled();
  });

  it('installs a package for this level, and one that names no level', async () => {
    for (const extra of [{ requires: { api: 3 } }, {}]) {
      const raw = manifest(extra);
      vi.stubGlobal('fetch', fakeGithub(raw));
      install.mockClear();
      const res = await installRequest(hashOf(raw));
      expect(res.status).toBe(201);
      expect(install).toHaveBeenCalledTimes(1);
    }
  });
});

describe('POST /api/widget-packages/install and the cluster minimum', () => {
  it('refuses a version a node that is behind cannot run, naming that node', async () => {
    const raw = manifest({ requires: { api: 9 } });
    vi.stubGlobal('fetch', fakeGithub(raw));
    const message = 'This package needs widget API level 9, but these cluster nodes cannot run it: b (level 8). Finish updating the cluster first.';
    clusterProblem.mockResolvedValueOnce({ message, status: 422, code: 'CLUSTER_BEHIND' });
    const res = await installRequest(hashOf(raw));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { message, code: 'CLUSTER_BEHIND' } });
    expect(install).not.toHaveBeenCalled();
    expect(clusterProblem).toHaveBeenCalledWith(9);
  });

  it('proceeds when every voter can run it', async () => {
    const raw = manifest({ requires: { api: 9 } });
    vi.stubGlobal('fetch', fakeGithub(raw));
    const res = await installRequest(hashOf(raw));
    expect(res.status).toBe(201);
    expect(clusterProblem).toHaveBeenCalledWith(9);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
