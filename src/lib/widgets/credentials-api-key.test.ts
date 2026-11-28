import { describe, it, expect, vi } from 'vitest';
import type { TokenPayload } from '@/lib/auth/jwt';
import { validateCredentialKinds } from './credentials-schema';

// An API key with `docker.view` on every server must see a destination exactly as a signed-in user does: the same
// public fields, the same filtering by server, and never a secret. The key's holder knows the server by name, so the
// listing also has to accept a name where the web UI sends an id.
const h = vi.hoisted(() => ({
  grants: [{ permission: 'docker.view', scope_type: 'all', scope_id: null, effect: 'allow', resource_kind: null, resource_name: null, expires_at: null }],
}));

vi.mock('@/lib/db/rqlite-client', () => {
  const result = (cols: string[], values: unknown[][]) => ({ columns: cols, values });
  return {
    rqlite: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q === 'SELECT id FROM servers') return result(['id'], [['s1']]);
        if (q.includes('FROM servers')) return result(['id'], params.includes('s1') || params.includes('AI-NUC') ? [['s1']] : []);
        if (q.includes('FROM server_group_members')) return result(['server_id', 'server_group_id'], []);
        if (q.includes('FROM permission_definitions')) {
          return result(['id', 'source', 'label', 'description', 'group_name', 'default_level', 'risk', 'scope', 'implies'], [
            ['docker.view', 'package:docker', 'See Docker', '', 'Docker', 'viewer', 'low', 'server', '[]'],
            ['docker.backup_config', 'package:docker', 'Manage destinations', '', 'Docker', 'admin', 'high', 'server', '[]'],
          ]);
        }
        if (q.includes('JOIN api_key_groups')) {
          return result(['permission', 'scope_type', 'scope_id', 'effect', 'resource_kind', 'resource_name', 'expires_at'], h.grants.map(g => [g.permission, g.scope_type, g.scope_id, g.effect, g.resource_kind, g.resource_name, g.expires_at]));
        }
        if (q.includes('JOIN user_groups')) {
          return result(['permission', 'scope_type', 'scope_id', 'effect', 'resource_kind', 'resource_name', 'expires_at'], h.grants.map(g => [g.permission, g.scope_type, g.scope_id, g.effect, g.resource_kind, g.resource_name, g.expires_at]));
        }
        if (q.includes('FROM custom_widgets')) return result(['package_id'], [['docker']]);
        if (q.includes('FROM widget_credentials')) {
          return result(['id', 'package_id', 'kind', 'name', 'public_fields', 'servers', 'is_default', 'created_at', 'created_by', 'updated_at', 'updated_by', 'last_used_at', 'last_used_by', 'last_used_action'], [
            ['b1', 'docker', 'backup_destination', 'Backup-Test', JSON.stringify({ repository: '/srv/bosun-backup-test' }), JSON.stringify(['s1']), 0, 'now', null, 'now', null, null, null, null],
          ]);
        }
        return result([], []);
      }),
      execute: vi.fn(async () => ({ rows_affected: 1 })),
    },
    rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
  };
});
vi.mock('@/lib/crypto/keys', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }));
vi.mock('@/lib/secrets', () => ({ getMasterKey: () => 'master' }));
vi.mock('@/lib/widgets/package-secrets', () => ({ getPackageSecrets: vi.fn(async () => ({})), deletePackageSecret: vi.fn(async () => true) }));
const kinds = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@/lib/widgets/package-store', () => ({
  getInstalledPackage: vi.fn(async (id: string) => ({ pkg: { id, manifest: { credentials: kinds.value } } })),
  listInstalledPackages: vi.fn(async () => []),
}));

import { canManageKind, canViewKind, entryViewable, viewTargets } from './credential-access';
import { invalidatePermissionCache } from '@/lib/permissions/store';
import { listCredentialEntries } from './credentials';

const raw = [{
  id: 'backup_destination', label: 'Backup destination', permission: 'docker.backup_config', view_permission: 'docker.view',
  fields: [{ id: 'repository', type: 'string', public: true }, { id: 'password', type: 'secret' }],
  servers: 'required', default_per_server: true,
}];
const validated = (() => {
  const r = validateCredentialKinds(raw, new Set(['docker.view', 'docker.backup_config']));
  if (!r.ok) throw new Error(r.error);
  kinds.value = r.value as unknown[];
  return r.value;
})();
const backup = validated[0];

const apiKey = { userId: 'apikey:k1', username: 'api-key', role: 'viewer', authType: 'api_key', apiKeyId: 'k1' } as TokenPayload;
const user = { userId: 'u1', username: 'owner', role: 'viewer', authType: 'session' } as TokenPayload;

describe('an API key with the view permission', () => {
  it('may see the kind, and cannot manage it without the write permission', async () => {
    expect(await canViewKind(apiKey, backup)).toBe(true);
    expect(await canManageKind(apiKey, backup)).toBe(false);
    expect(await canViewKind(user, backup)).toBe(true);
  });

  it('sees the same public fields as a user, by server id and by server name', async () => {
    const byId = await listCredentialEntries('docker', backup, 's1');
    const byName = await listCredentialEntries('docker', backup, 'AI-NUC');
    expect(byName).toEqual(byId);
    expect(byId[0]).toMatchObject({ name: 'Backup-Test', fields: { repository: '/srv/bosun-backup-test' } });
    expect(byId[0].secrets.password).toEqual({ set: false, hint: null });
    expect(JSON.stringify(byId)).not.toContain('enc:');
  });

  it('sees no entry, but still may view the kind, for a server it does not cover', async () => {
    expect(await listCredentialEntries('docker', backup, 'AI-OTHER')).toEqual([]);
    expect(await canViewKind(apiKey, backup)).toBe(true);
  });
});

describe('the servers a caller may read credentials on', () => {
  it('resolves them from the view permission, never from the manage permission', async () => {
    expect(await viewTargets(apiKey, backup)).toEqual(['s1']);   // level grants of the viewer role
    const plain = { ...apiKey, role: 'user' } as TokenPayload;   // no level grants at all
    h.grants = [{ permission: 'docker.backup_config', scope_type: 'all', scope_id: null, effect: 'allow', resource_kind: null, resource_name: null, expires_at: null }];
    invalidatePermissionCache();
    expect(await viewTargets(plain, backup)).toEqual([]);
    const serversView = { permission: 'servers.view', scope_type: 'all', scope_id: null, effect: 'allow', resource_kind: null, resource_name: null, expires_at: null };
    h.grants = [serversView, { permission: 'docker.view', scope_type: 'all', scope_id: null, effect: 'allow', resource_kind: null, resource_name: null, expires_at: null }];
    invalidatePermissionCache();
    expect(await viewTargets(plain, backup)).toEqual(['s1']);
  });

  it('shows an entry only when every server it applies to is one the caller may view', () => {
    expect(entryViewable(['s1'], ['s1'])).toBe(true);
    expect(entryViewable([], ['s1'])).toBe(true);
    expect(entryViewable(['s1'], [])).toBe(false);
    expect(entryViewable(['s1', 's2'], ['s1'])).toBe(false);
    expect(entryViewable([], [])).toBe(false);
  });
});
