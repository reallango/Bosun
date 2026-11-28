/**
 * Editing a credential entry: the permission a write needs must cover the servers the entry will apply to, not only
 * the ones it happened to be scoped to before. An empty `servers` list means "every server".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  manageCalls: [] as string[][],
  entry: { id: 'e1', name: 'Backup', servers: ['s1'] } as { id: string; name: string; servers: string[] },
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => ({ userId: 'u1', username: 'u', role: 'operator', authType: 'user' }),
  clientIp: () => '10.0.0.1',
}));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => {}, AuditActions: { WIDGET_CREDENTIAL: 'widget_credential.change' } }));
vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: { query: async () => ({ columns: [], values: [] }) }, rowsToObjects: () => [] }));
vi.mock('@/lib/widgets/package-store', () => ({ getInstalledPackage: async () => null }));
vi.mock('@/lib/widgets/credentials', () => ({
  getCredentialEntry: async () => h.entry,
  updateCredential: async (_pkg: string, _kind: unknown, id: string, body: Record<string, unknown>) => {
    h.updates.push(body);
    return { id, name: String(body.name ?? 'Backup'), servers: body.servers ?? [] };
  },
  createCredential: async () => ({ id: 'new', name: 'new', servers: [] }),
  deleteCredential: async () => true,
  listCredentialEntries: async () => [],
}));
vi.mock('@/lib/widgets/credential-access', () => ({
  canViewKind: async () => true,
  canManageKind: async () => true,
  publicKind: (k: unknown) => k,
  kindForType: async () => ({
    packageId: 'pkg',
    kind: { id: 'backup', label: 'Backup', permission: 'docker.credentials' },
    kinds: [{ id: 'backup', label: 'Backup', permission: 'docker.credentials' }],
  }),
  requireKindManage: async (_auth: unknown, _kind: unknown, servers: string[]) => { h.manageCalls.push(servers); return null; },
  manageTargets: (existing: string[], next: string[] | null) => {
    if (next === null) return existing;
    if (!next.length) return [];
    return Array.from(new Set([...existing, ...next]));
  },
}));

import { PUT } from './route';

function put(b: Record<string, unknown>): NextRequest {
  return new NextRequest('https://bosun.test/api/widgets/docker_containers/credentials', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'backup', id: 'e1', ...b }),
  });
}
const params = { params: Promise.resolve({ widgetId: 'docker_containers' }) };

describe('PUT /api/widgets/[widgetId]/credentials', () => {
  beforeEach(() => { h.manageCalls = []; h.updates = []; h.entry = { id: 'e1', name: 'Backup', servers: ['s1'] }; });

  it('asks for the permission on every server when the entry is widened to all of them', async () => {
    const res = await PUT(put({ name: 'Backup', servers: [] }), params);
    expect(res.status).toBe(200);
    expect(h.manageCalls).toEqual([[]]);
    expect(h.updates[0].servers).toEqual([]);
  });

  it('asks for the old scope as well as the new one', async () => {
    await PUT(put({ name: 'Backup', servers: ['s2'] }), params);
    expect(h.manageCalls).toEqual([['s1', 's2']]);
  });

  it('keeps the scope and asks for it when the body leaves it out', async () => {
    await PUT(put({ name: 'Renamed' }), params);
    expect(h.manageCalls).toEqual([['s1']]);
  });
});
