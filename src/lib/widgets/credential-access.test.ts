import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateCredentialKinds, type CredentialKindDef } from './credentials-schema';

const h = vi.hoisted(() => ({
  typeRow: { package_id: 'pkg' } as { package_id: string } | null,
  servers: [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }],
  visible: '*' as '*' | Set<string>,
  perms: new Set<string>(),
}));

vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: {
    query: vi.fn(async (sql: string) => (sql.includes('custom_widgets')
      ? { columns: ['package_id'], values: h.typeRow ? [[h.typeRow.package_id]] : [] }
      : { columns: ['id', 'name'], values: h.servers.map(s => [s.id, s.name]) })),
  },
  rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
}));
vi.mock('@/lib/widgets/package-store', () => ({
  getInstalledPackage: vi.fn(async (id: string) => ({ pkg: { id, manifest: { credentials: kinds } } })),
}));
// `h.perms` holds "permission:serverId": the same set, as the grants a group would hold.
vi.mock('@/lib/permissions/effective', () => ({
  visibleServerIds: vi.fn(async () => h.visible),
  effectiveGrants: vi.fn(async () => Array.from(h.perms).map(p => {
    const [permission, id] = p.split(':');
    return { permission, scope: { type: 'server', id }, effect: 'allow' };
  })),
}));
// The package's own definitions, as the installer registers them (`admin` level so only the grants above count).
vi.mock('@/lib/permissions/store', () => ({
  allServerContexts: vi.fn(async () => h.servers),
  registeredPermissionDefs: vi.fn(async () => ['docker.view', 'docker.credentials'].map(id => ({
    id, source: 'package:pkg', label: id, description: '', group: 'Docker', defaultLevel: 'admin' as const, risk: 'low' as const, scope: 'server' as const, implies: [],
  }))),
}));
vi.mock('@/lib/permissions/authorize', () => ({
  hasPermission: vi.fn(async (_auth: unknown, permission: string, serverId: string) => h.perms.has(`${permission}:${serverId}`)),
  requirePermission: vi.fn(async () => null),
}));

import { canManageKind, canViewKind, kindForType, publicKind, serverChoices } from './credential-access';

const raw = [{
  id: 'git', label: 'Git access', permission: 'docker.credentials', view_permission: 'docker.view',
  fields: [{ id: 'host', type: 'string', public: true }, { id: 'scope', type: 'string', public: true, optional: true }, { id: 'token', type: 'secret' }],
  match: { url: 'host+scope' },
  migrate: [{ name: 'GitHub (migrated)', fields: { host: 'literal:github.com', token: 'secret:git_token' } }],
}];
const kinds: CredentialKindDef[] = (() => {
  const r = validateCredentialKinds(raw, new Set(['docker.credentials', 'docker.view']), new Set(['git_token']));
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();
const git = kinds[0];
const admin = { role: 'admin' } as never;
const user = { role: 'user', userId: 'u1' } as never;

beforeEach(() => { h.perms = new Set(); h.visible = '*'; h.typeRow = { package_id: 'pkg' }; });

describe('who may view and manage credentials', () => {
  it('lets an admin do both', async () => {
    expect(await canViewKind(admin, git)).toBe(true);
    expect(await canManageKind(admin, git)).toBe(true);
  });

  it('separates the view permission from the manage permission', async () => {
    h.perms = new Set(['docker.view:s1']);
    expect(await canViewKind(user, git)).toBe(true);
    expect(await canManageKind(user, git)).toBe(false);
    h.perms = new Set(['docker.credentials:s1']);
    expect(await canManageKind(user, git)).toBe(true);
  });

  it('counts a grant limited to a stack or container for viewing (it shows the widget, it does not act on it)', async () => {
    h.perms = new Set(['docker.view:s1']);
    expect(await canViewKind(user, git)).toBe(true);
  });

  it('denies both without a permission on a visible server', async () => {
    h.perms = new Set(['docker.view:s2']);
    h.visible = new Set(['s1']);
    expect(await canViewKind(user, git)).toBe(false);
    expect(await canManageKind(user, git)).toBe(false);
  });
});

describe('the kind as the UI and MCP see it', () => {
  it('keeps the public fields and drops the migration rules', () => {
    expect(publicKind(git)).toEqual({
      id: 'git', label: 'Git access', permission: 'docker.credentials', viewPermission: 'docker.view',
      fields: git.fields, match: { url: 'host+scope' }, servers: 'optional', defaultPerServer: false,
    });
    expect(JSON.stringify(publicKind(git))).not.toContain('migrate');
  });

  it('finds a kind of the package behind a widget type, and no kind for an unknown one', async () => {
    expect((await kindForType('docker_containers', 'git'))?.packageId).toBe('pkg');
    expect(await kindForType('docker_containers', 'nope')).toBeNull();
    h.typeRow = null;
    expect(await kindForType('docker_containers', 'git')).toBeNull();
  });

  it('offers only the servers the caller may see', async () => {
    expect(await serverChoices(admin)).toEqual([{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }]);
    h.visible = new Set(['s2']);
    expect(await serverChoices(user)).toEqual([{ id: 's2', name: 'Two' }]);
  });
});
