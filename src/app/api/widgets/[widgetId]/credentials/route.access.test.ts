import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { NextRequest } from 'next/server';
import type { TokenPayload } from '@/lib/auth/jwt';
import { validateManifest } from '@/lib/widgets/package-manifest';
import { invalidatePermissionCache } from '@/lib/permissions/store';

/**
 * The credentials list against the real Docker manifest: the entries it returns depend on the caller's *view*
 * permission for each server an entry applies to, never on the kind's manage permission (`docker.backup_config`), and
 * never on servers the caller cannot see. A destination stored for one server used to be invisible to an API key that
 * holds `docker.view` there, and the list leaked entries of servers a group hides.
 */
const S1 = '1ac60a24-0737-4dc3-b43d-5afa8320529c';   // "AI-NUC"
const S2 = '2bd60a24-0737-4dc3-b43d-5afa8320529c';   // "AI-OTHER"

const h = vi.hoisted(() => ({
  auth: null as unknown,
  /** Rows of `permission_grants` the caller holds through its groups: [permission, scope, id, effect]. */
  grants: [] as [string, 'all' | 'server' | 'server_group', string | null, 'allow' | 'deny'][],
}));

const result = (columns: string[], values: unknown[][]) => ({ columns, values });

vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.includes('SELECT package_id FROM custom_widgets')) return result(['package_id'], [['docker']]);
      if (q === 'SELECT id, name FROM servers ORDER BY name') return result(['id', 'name'], [[S1, 'AI-NUC'], [S2, 'AI-OTHER']]);
      if (q === 'SELECT id FROM servers') return result(['id'], [[S1], [S2]]);
      if (q === 'SELECT id FROM servers WHERE id = ? OR name = ?') {
        const ref = String(params[0]);
        const hit = ref === S1 || ref === 'AI-NUC' ? S1 : ref === S2 || ref === 'AI-OTHER' ? S2 : null;
        return result(['id'], hit ? [[hit]] : []);
      }
      if (q.includes('FROM server_group_members')) return result(['server_id', 'server_group_id'], []);
      if (q.includes('FROM permission_definitions')) return result(permissionColumns, permissionRows);
      if (q.includes('JOIN api_key_groups') || q.includes('JOIN user_groups')) {
        return result(grantColumns, h.grants.map(([p, scope, id, effect]) => [p, scope, id, effect, null, null, null]));
      }
      if (q.includes('FROM widget_credentials') && q.includes('secrets_enc')) return result(['secrets_enc'], [['{}']]);
      if (q.includes('FROM widget_credentials')) {
        // One entry per server of the cluster, plus one that applies everywhere and one of the other kind.
        const [packageId, kind] = params as string[];
        const rows = credentialRows.filter(r => r[1] === packageId && r[2] === kind).sort((a, b) => String(a[3]).localeCompare(String(b[3])));
        return result(
          ['id', 'package_id', 'kind', 'name', 'public_fields', 'servers', 'is_default', 'created_at', 'created_by', 'updated_at', 'updated_by', 'last_used_at', 'last_used_by', 'last_used_action'],
          rows,
        );
      }
      return result([], []);
    }),
    execute: vi.fn(async () => ({ rows_affected: 1 })),
  },
  rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
}));

const credentialRows: unknown[][] = [
  ['b1', 'docker', 'backup_destination', 'Backup-Test', JSON.stringify({ repository: '/srv/bosun-backup-test' }), JSON.stringify([S1]), 0, 'now', null, 'now', null, null, null, null],
  ['b2', 'docker', 'backup_destination', 'Everywhere', JSON.stringify({ repository: 'sftp:u@h:/srv' }), '[]', 0, 'now', null, 'now', null, null, null, null],
  ['b3', 'docker', 'backup_destination', 'Elsewhere', JSON.stringify({ repository: '/srv/other' }), JSON.stringify([S2]), 0, 'now', null, 'now', null, null, null, null],
  ['g1', 'docker', 'git', 'GitHub', JSON.stringify({ host: 'github.com' }), '[]', 0, 'now', null, 'now', null, null, null, null],
];

const grantColumns = ['permission', 'scope_type', 'scope_id', 'effect', 'resource_kind', 'resource_name', 'expires_at'];
const permissionColumns = ['id', 'source', 'label', 'description', 'group_name', 'default_level', 'risk', 'scope', 'implies'];
let permissionRows: unknown[][] = [];

vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: vi.fn(async () => h.auth),
  clientIp: () => null,
}));
vi.mock('@/lib/audit/logger', () => ({ logAudit: vi.fn(async () => undefined), AuditActions: { WIDGET_CREDENTIAL: 'widget_credential' } }));
vi.mock('@/lib/crypto/keys', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/secrets', () => ({ getMasterKey: () => 'master' }));
vi.mock('@/lib/widgets/package-secrets', () => ({ getPackageSecrets: vi.fn(async () => ({})), deletePackageSecret: vi.fn(async () => true) }));

// The real bundled Docker manifest (parsed as the store parses it), so the kinds, their permissions and their levels
// are the ones the image ships.
const dockerManifest = (() => {
  const raw = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
  const v = validateManifest(raw);
  if (!v.ok) throw new Error(v.error);
  return v.value as unknown as { version: string; permissions: { id: string; label: string; description: string; group: string; defaultLevel: string; risk: string; scope: string; implies?: string[] }[] };
})();
permissionRows = dockerManifest.permissions.map(p => [
  p.id, 'package:docker', p.label, p.description, p.group, p.defaultLevel, p.risk, p.scope, JSON.stringify(p.implies ?? []),
]);
vi.mock('@/lib/widgets/package-store', () => ({
  getInstalledPackage: vi.fn(async (id: string) => ({ pkg: { id, manifest: dockerManifest } })),
  listInstalledPackages: vi.fn(async () => []),
}));


import { GET } from './route';

const apiKey = (over: Partial<TokenPayload> = {}): TokenPayload => (
  { userId: 'apikey:k1', username: 'api-key', role: 'viewer', authType: 'api_key', apiKeyId: 'k1', ...over } as TokenPayload
);
const user = (over: Partial<TokenPayload> = {}): TokenPayload => (
  { userId: 'u1', username: 'owner', role: 'viewer', authType: 'session', ...over } as TokenPayload
);

const list = async (query: string) => {
  const url = `http://localhost/api/widgets/docker_containers/credentials${query}`;
  const res = await GET(new NextRequest(url), { params: Promise.resolve({ widgetId: 'docker_containers' }) });
  return { status: res.status, body: await res.json() as { data?: { kinds: { id: string; entries: { name: string }[]; canManage: boolean }[] }; error?: { code?: string } } };
};
const names = (body: Awaited<ReturnType<typeof list>>['body'], kind = 'backup_destination') =>
  body.data?.kinds.find(k => k.id === kind)?.entries.map(e => e.name) ?? [];

beforeEach(() => {
  h.auth = null;
  h.grants = [];
  invalidatePermissionCache();   // the store caches grants per principal and definitions for 30 s
});

describe('the credentials list a caller sees', () => {
  it('lists the entry of a server the caller may view, whether it sends the id or the name', async () => {
    h.auth = apiKey();
    const byId = await list(`?kind=backup_destination&server_id=${S1}`);
    expect(byId.status).toBe(200);
    expect(names(byId.body)).toEqual(['Backup-Test', 'Everywhere']);
    const byName = await list('?kind=backup_destination&server_id=AI-NUC');
    expect(names(byName.body)).toEqual(['Backup-Test', 'Everywhere']);
    // The public field and the secret status only: never a value.
    const entry = byId.body.data!.kinds[0].entries[0] as unknown as { fields: Record<string, string>; secrets: Record<string, unknown> };
    expect(entry.fields).toEqual({ repository: '/srv/bosun-backup-test' });
    expect(entry.secrets).toEqual({ password: { set: false, hint: null }, credentials: { set: false, hint: null } });
    expect(JSON.stringify(byId.body)).not.toContain('enc:');
  });

  it('does not need the kind\'s manage permission to read (a viewer never holds docker.backup_config)', async () => {
    h.auth = apiKey();
    const { body } = await list('?kind=backup_destination');
    expect(names(body)).toContain('Backup-Test');
    expect(body.data!.kinds[0].canManage).toBe(false);
  });

  it('hides the entries of a server where the caller may not view the kind', async () => {
    // Read only everywhere, but a group takes the Docker view of the other server away.
    h.grants = [['docker.view', 'server', S2, 'deny']];
    h.auth = apiKey();
    expect(names((await list('?kind=backup_destination')).body)).toEqual(['Backup-Test', 'Everywhere']);
    expect(names((await list(`?kind=backup_destination&server_id=${S2}`)).body)).toEqual(['Everywhere']);
  });

  it('hides an entry scoped to a server a group hides from the caller', async () => {
    h.grants = [['servers.view', 'server', S2, 'deny']];
    h.auth = apiKey();
    const { body } = await list('?kind=backup_destination');
    expect(names(body)).toEqual(['Backup-Test', 'Everywhere']);
  });

  it('shows a signed-in user exactly what an API key with the same rights sees', async () => {
    h.grants = [['docker.view', 'server', S2, 'deny']];
    h.auth = apiKey();
    const key = await list('?kind=backup_destination');
    h.auth = user();
    const session = await list('?kind=backup_destination');
    expect(session.body).toEqual(key.body);
  });

  it('refuses the kind when the caller may not view it anywhere, and omits it from the full list', async () => {
    h.grants = [['docker.view', 'all', null, 'deny']];
    h.auth = apiKey();
    const one = await list('?kind=backup_destination');
    expect(one.status).toBe(403);
    expect(one.body.error?.code).toBe('FORBIDDEN');
    const all = await list('');
    expect(all.status).toBe(200);
    expect(all.body.data!.kinds.map(k => k.id)).toEqual([]);
  });

  it('shows every entry, of every kind, to Full access', async () => {
    h.auth = apiKey({ role: 'admin' });
    const { body } = await list('');
    expect(body.data!.kinds.map(k => k.id)).toEqual(['git', 'backup_destination']);
    expect(names(body)).toEqual(['Backup-Test', 'Elsewhere', 'Everywhere']);
    expect(names(body, 'git')).toEqual(['GitHub']);
  });
});
