import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const install = vi.hoisted(() => vi.fn());

vi.mock('@/lib/widgets/package-routes', () => ({
  requirePackageAdmin: async () => ({ userId: 'u1' }),
  requestIp: () => '127.0.0.1',
}));
vi.mock('@/lib/audit/logger', () => ({
  logAudit: async () => undefined,
  AuditActions: { WIDGET_PACKAGE_INSTALL: 'widget_package.install' },
}));
vi.mock('@/lib/widgets/package-store', () => ({
  installPackage: install,
  getInstalledPackage: async () => null,
  secretsWouldBeCleared: async () => false,
}));

import { POST } from './route';
import { writeZip } from '@/lib/widgets/zip';

const manifest = (extra: Record<string, unknown> = {}) => ({
  schema: 1, id: 'alpha', name: 'Alpha', version: '1.0.0',
  widgets: [{ type: 'alpha_w', display_name: 'Alpha' }],
  ...extra,
});

const importZip = (raw: unknown, query = '') => {
  const zip = writeZip({ 'manifest.json': JSON.stringify(raw) });
  return POST(new NextRequest(`http://localhost/api/widget-packages/import${query}`, { method: 'POST', body: new Uint8Array(zip) }));
};

beforeEach(() => {
  install.mockReset().mockResolvedValue({
    id: 'alpha', version: '1.0.0', previousVersion: null, widgetTypes: ['alpha_w'], permissions: [], secretsCleared: false,
  });
});

describe('POST /api/widget-packages/import and the widget API level', () => {
  it('refuses a package that needs a newer Bosun', async () => {
    const res = await importZip(manifest({ requires: { api: 99 } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { message: 'This widget needs a newer Bosun (widget API level 99; this Bosun has 7). Update Bosun first.', code: 'NEWER_BOSUN_REQUIRED' },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('refuses the same package on a dry run too', async () => {
    const res = await importZip(manifest({ requires: { api: 99 } }), '?dry_run=1');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('NEWER_BOSUN_REQUIRED');
    expect(install).not.toHaveBeenCalled();
  });

  it('imports a package for this level, and one that names no level', async () => {
    for (const extra of [{ requires: { api: 3 } }, {}]) {
      install.mockClear();
      const res = await importZip(manifest(extra));
      expect(res.status).toBe(201);
      expect(install).toHaveBeenCalledTimes(1);
      expect(install.mock.calls[0][0].manifest.requires).toEqual((extra as { requires?: unknown }).requires);
    }
  });
});
