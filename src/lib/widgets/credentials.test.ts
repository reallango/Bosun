import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateCredentialKinds, type CredentialKindDef } from './credentials-schema';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  servers: [] as string[],
  serverNames: {} as Record<string, string>,
  packages: [] as { id: string; manifest: { credentials: CredentialKindDef[] } }[],
  legacy: {} as Record<string, string>,
  deleted: [] as string[],
  sql: [] as string[],
}));
const ps = vi.hoisted(() => ({ legacy: {} as Record<string, string>, deleted: [] as string[] }));

vi.mock('@/lib/crypto/keys', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('@/lib/secrets', () => ({ getMasterKey: () => 'master' }));
vi.mock('@/lib/db/rqlite-client', () => {
  const COLUMNS = ['id', 'package_id', 'kind', 'name', 'public_fields', 'secrets_enc', 'servers', 'is_default', 'created_at', 'created_by', 'updated_at', 'updated_by', 'last_used_at', 'last_used_by', 'last_used_action'];
  const result = (cols: string[], rows: Record<string, unknown>[]) => ({ columns: cols, values: rows.map(r => cols.map(c => r[c])) });
  return {
    rqlite: {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        h.sql.push(sql);
        const q = sql.replace(/\s+/g, ' ').trim();
        if (!q.startsWith('SELECT')) return { columns: [], values: [] };
        if (q.includes('DISTINCT w.server_id')) return result(['server_id'], h.servers.map(s => ({ server_id: s })));
        if (q.includes('FROM servers')) {
          const found = Object.entries(h.serverNames).find(([id, name]) => params.includes(id) || params.includes(name));
          return result(['id'], found ? [{ id: found[0] }] : []);
        }
        if (!q.includes('FROM widget_credentials')) return { columns: [], values: [] };
        let rows = [...h.rows];
        if (q.includes('WHERE id = ? AND package_id = ? AND kind = ?')) rows = rows.filter(r => r.id === params[0] && r.package_id === params[1] && r.kind === params[2]);
        else if (q.includes('WHERE package_id = ? AND kind = ?')) rows = rows.filter(r => r.package_id === params[0] && r.kind === params[1]);
        else if (q.includes('WHERE id = ?')) rows = rows.filter(r => r.id === params[0]);
        if (/is_default = 1/.test(q)) rows = rows.filter(r => Number(r.is_default) === 1 && (params.length < 3 || r.id !== params[2]));
        if (q.includes('is_default = 0')) rows = rows.filter(r => Number(r.is_default) === 0);
        if (q.includes('ORDER BY name')) rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const picked = /^SELECT (.*?) FROM/.exec(q)?.[1].split(',').map(s => s.trim()) ?? COLUMNS;
        return result(picked, rows);
      }),
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        h.sql.push(sql);
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q.startsWith('INSERT')) {
          const id = String(params[0]);
          if (q.includes('OR IGNORE') && h.rows.some(r => r.id === id)) return { rows_affected: 0 };
          h.rows.push({
            id, package_id: params[1], kind: params[2], name: params[3], public_fields: params[4], secrets_enc: params[5],
            servers: params[6], is_default: params[7], created_at: 'now', created_by: params[8] ?? null,
            updated_at: 'now', updated_by: params[9] ?? null, last_used_at: null, last_used_by: null, last_used_action: null,
          });
          return { rows_affected: 1 };
        }
        if (q.startsWith('UPDATE widget_credentials SET name = ?')) {
          const row = h.rows.find(r => r.id === params[6]);
          if (row) Object.assign(row, { name: params[0], public_fields: params[1], secrets_enc: params[2], servers: params[3], is_default: params[4], updated_by: params[5] });
          return { rows_affected: row ? 1 : 0 };
        }
        if (q.includes('SET is_default = 0')) {
          const row = h.rows.find(r => r.id === params[0]);
          if (row) row.is_default = 0;
          return { rows_affected: 1 };
        }
        if (q.startsWith('UPDATE widget_credentials SET is_default = 1 WHERE id = ?')) {
          const row = h.rows.find(r => r.id === params[0]);
          if (row) row.is_default = 1;
          return { rows_affected: row ? 1 : 0 };
        }
        if (q.includes('SET last_used_at')) {
          const row = h.rows.find(r => r.id === params[1]);
          if (row) { row.last_used_at = 'used'; row.last_used_action = params[0]; }
          return { rows_affected: 1 };
        }
        if (q.startsWith('DELETE FROM widget_credentials WHERE id = ? AND package_id = ?')) {
          const before = h.rows.length;
          h.rows = h.rows.filter(r => !(r.id === params[0] && r.package_id === params[1]));
          return { rows_affected: before - h.rows.length };
        }
        if (q.startsWith('DELETE FROM widget_credentials WHERE package_id = ?')) {
          const before = h.rows.length;
          h.rows = h.rows.filter(r => r.package_id !== params[0]);
          return { rows_affected: before - h.rows.length };
        }
        return { rows_affected: 0 };
      }),
    },
    rowsToObjects: (r: { columns: string[]; values: unknown[][] }) => (r.values ?? []).map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))),
  };
});
vi.mock('@/lib/widgets/package-secrets', () => ({
  getPackageSecrets: vi.fn(async (_pkg: string, ids: string[]) => Object.fromEntries(ids.filter(id => id in ps.legacy).map(id => [id, ps.legacy[id]]))),
  deletePackageSecret: vi.fn(async (_pkg: string, id: string) => { ps.deleted.push(id); delete ps.legacy[id]; return true; }),
}));
vi.mock('@/lib/widgets/package-store', () => ({
  listInstalledPackages: vi.fn(async () => h.packages),
}));

import {
  createCredential, deleteCredential, getCredentialEntry, listCredentialEntries, migratePackageCredentials,
  resolveCredentialUses, updateCredential, CredentialError,
} from './credentials';

const rawKinds = [
  {
    id: 'git', label: 'Git access', permission: 'docker.credentials',
    fields: [
      { id: 'host', type: 'string', public: true }, { id: 'scope', type: 'string', public: true, optional: true },
      { id: 'username', type: 'string', public: true, optional: true }, { id: 'token', type: 'secret' },
    ],
    match: { url: 'host+scope' }, servers: 'optional',
    migrate: [
      { name: 'GitHub (migrated)', fields: { host: 'literal:github.com', token: 'secret:git_token' } },
      { name: 'Git ({host})', host_list: { secret: 'git_credentials', hostField: 'host', tokenField: 'token', usernameField: 'username' } },
    ],
  },
  {
    id: 'backup_destination', label: 'Backup destination', permission: 'docker.backup_config',
    fields: [{ id: 'repository', type: 'string', public: true }, { id: 'password', type: 'secret' }, { id: 'credentials', type: 'secret', optional: true }],
    servers: 'required', default_per_server: true,
    migrate: [{ name: 'Backups (migrated)', default_for_package_servers: true, fields: { repository: 'secret:backup_repository', password: 'secret:backup_password' } }],
  },
];
const kinds = (() => {
  const r = validateCredentialKinds(rawKinds, new Set(['docker.credentials', 'docker.backup_config']), new Set(['git_token', 'git_credentials', 'backup_repository', 'backup_password']));
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();
const git = kinds[0];
const backup = kinds[1];

const add = (id: string, kind: CredentialKindDef, fields: Record<string, string>, secrets: Record<string, string>, servers: string[] = [], isDefault = false) => {
  h.rows.push({
    id, package_id: 'pkg', kind: kind.id, name: id, public_fields: JSON.stringify(fields),
    secrets_enc: JSON.stringify(Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, `enc:${v}`]))),
    servers: JSON.stringify(servers), is_default: isDefault ? 1 : 0, created_at: 'now', created_by: null,
    updated_at: `2026-01-0${h.rows.length + 1}`, updated_by: null, last_used_at: null, last_used_by: null, last_used_action: null,
  });
};

beforeEach(() => {
  h.rows = []; h.servers = []; h.serverNames = {}; h.packages = []; h.sql = [];
  ps.legacy = {}; ps.deleted = [];
});

describe('reading credentials never returns a secret', () => {
  it('lists public fields, server scope and only whether each secret is set (its last four characters at most)', async () => {
    add('a', git, { host: 'github.com', scope: 'my-org' }, { token: 'supersecretvalue' });
    const [entry] = await listCredentialEntries('pkg', git);
    expect(entry).toMatchObject({ id: 'a', name: 'a', fields: { host: 'github.com', scope: 'my-org' }, secrets: { token: { set: true, hint: 'alue' } } });
    expect(JSON.stringify(entry)).not.toContain('supersecretvalue');
    expect(JSON.stringify(entry)).not.toContain('enc:');
    const one = await getCredentialEntry('pkg', git, 'a');
    expect(JSON.stringify(one)).not.toContain('supersecretvalue');
  });

  it('says a secret is not set when it is empty, and never selects the secret column for a list', async () => {
    add('a', git, { host: 'github.com' }, {});
    const [entry] = await listCredentialEntries('pkg', git);
    expect(entry.secrets.token).toEqual({ set: false, hint: null });
    const listSql = h.sql.find(s => s.includes('FROM widget_credentials WHERE package_id'));
    expect(listSql).toBeDefined();
    expect(listSql).not.toContain('secrets_enc');
  });

  it('narrows the list to the entries a server may use', async () => {
    add('all', git, { host: 'github.com' }, { token: 'x' });
    add('other', git, { host: 'github.com', scope: 'o' }, { token: 'y' }, ['s2']);
    expect((await listCredentialEntries('pkg', git, 's1')).map(e => e.id)).toEqual(['all']);
  });

  it('finds the entries when a caller names the server instead of its id (an API or MCP caller)', async () => {
    h.serverNames = { s1: 'AI-NUC' };
    add('all', git, { host: 'github.com' }, { token: 'x' });
    add('one', git, { host: 'gitlab.com' }, { token: 'y' }, ['s1']);
    for (const ref of ['s1', 'AI-NUC']) {
      expect((await listCredentialEntries('pkg', git, ref)).map(e => e.id).sort()).toEqual(['all', 'one']);
    }
  });
});

describe('writing credentials', () => {
  it('leaves a secret unchanged on an edit that does not type a new one, and clears it with null', async () => {
    add('a', git, { host: 'github.com' }, { token: 'keep-me-please' });
    const renamed = await updateCredential('pkg', git, 'a', { name: 'renamed' }, 'u1');
    expect(renamed.secrets.token).toEqual({ set: true, hint: 'ease' });
    const cleared = await updateCredential('pkg', git, 'a', { secrets: { token: null } }, 'u1');
    expect(cleared.secrets.token).toEqual({ set: false, hint: null });
  });

  it('makes the first entry of each server the default, and leaves later ones alone', async () => {
    const first = await createCredential('pkg', backup, { name: 'one', fields: { repository: '/srv/one' }, secrets: { password: 'p' }, servers: ['s1'] }, null);
    expect(first.isDefault).toBe(true);
    const second = await createCredential('pkg', backup, { name: 'two', fields: { repository: '/srv/two' }, secrets: { password: 'p' }, servers: ['s1'] }, null);
    expect(second.isDefault).toBe(false);
    const other = await createCredential('pkg', backup, { name: 'three', fields: { repository: '/srv/three' }, secrets: { password: 'p' }, servers: ['s2'] }, null);
    expect(other.isDefault).toBe(true);
    expect(h.rows.find(r => r.id === first.id)!.is_default).toBe(1);
  });

  it('re-assigns the default of a server when its default entry is deleted', async () => {
    const a = await createCredential('pkg', backup, { name: 'a', fields: { repository: '/a' }, secrets: { password: 'p' }, servers: ['s1'] }, null);
    const b = await createCredential('pkg', backup, { name: 'b', fields: { repository: '/b' }, secrets: { password: 'p' }, servers: ['s1'] }, null);
    expect(a.isDefault).toBe(true);
    await deleteCredential('pkg', a.id, backup);
    expect(h.rows.map(r => [r.name, r.is_default])).toEqual([['b', 1]]);
    expect(b.isDefault).toBe(false);
  });

  it('rejects a missing required field and deletes an entry', async () => {
    await expect(createCredential('pkg', git, { name: 'x', fields: { host: 'github.com' } }, null)).rejects.toBeInstanceOf(CredentialError);
    const made = await createCredential('pkg', git, { name: 'x', fields: { host: 'github.com' }, secrets: { token: 't' } }, null);
    expect(await deleteCredential('pkg', made.id)).toBe(true);
    expect(h.rows).toHaveLength(0);
  });
});

describe('resolving a credential for a script', () => {
  beforeEach(() => {
    add('host', git, { host: 'github.com', scope: '' }, { token: 'tok-host' });
    add('org', git, { host: 'github.com', scope: 'my-org' }, { token: 'tok-org' });
    add('repo', git, { host: 'github.com', scope: 'my-org/my-repo' }, { token: 'tok-repo' });
    add('other', git, { host: 'github.com', scope: 'my-org/my-repo/other' }, { token: 'tok-other' }, ['s2']);
  });

  it('injects the longest-scope match as BOSUN_CRED_* and keeps the secret out of the parameters', async () => {
    const r = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo' }, 's1', 'docker:git_branches');
    expect(r.env).toEqual({ BOSUN_CRED_GIT_ID: 'repo', BOSUN_CRED_GIT_NAME: 'repo', BOSUN_CRED_GIT_HOST: 'github.com', BOSUN_CRED_GIT_SCOPE: 'my-org/my-repo', BOSUN_CRED_GIT_TOKEN: 'tok-repo' });
    expect(r.secrets).toEqual(['tok-repo']);
    expect(h.rows.find(r => r.id === 'repo')).toMatchObject({ last_used_action: 'docker:git_branches' });
  });

  it('falls back from repository to owner to whole host', async () => {
    const env = async (repo: string) => (await resolveCredentialUses('pkg', kinds, [{ kind: 'git', url: 'repo' }], { repo }, 's1', 'a')).env.BOSUN_CRED_GIT_SCOPE;
    expect(await env('https://github.com/my-org/my-repo')).toBe('my-org/my-repo');
    expect(await env('https://github.com/my-org/elsewhere')).toBe('my-org');
    expect(await env('https://github.com/someone/elsewhere')).toBeUndefined();
  });

  it('never uses an entry scoped to another server', async () => {
    const r = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo/other' }, 's1', 'a');
    expect(r.env.BOSUN_CRED_GIT_TOKEN).toBe('tok-repo');
  });

  it('uses a pinned entry, and refuses one that is not available on the server', async () => {
    const pinned = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo', credential: 'org' }, 's1', 'a');
    expect(pinned.env.BOSUN_CRED_GIT_TOKEN).toBe('tok-org');
    await expect(resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/x/y', credential: 'other' }, 's1', 'a')).rejects.toThrow(/not available on this server/);
  });

  it('leaves a URL with no match alone unless the use says it is required', async () => {
    expect(await resolveCredentialUses('pkg', kinds, [{ kind: 'git', url: 'repo' }], { repo: 'https://gitlab.com/o/r' }, 's1', 'a')).toEqual({ env: {}, secrets: [] });
    await expect(resolveCredentialUses('pkg', kinds, [{ kind: 'git', url: 'repo', required: true }], { repo: 'https://gitlab.com/o/r' }, 's1', 'a')).rejects.toThrow(/No git access matches https:\/\/gitlab.com\/o\/r/);
  });

  it('resolves auto and omitted credentials by URL', async () => {
    const auto = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo', credential: 'auto' }, 's1', 'a');
    expect(auto.env.BOSUN_CRED_GIT_TOKEN).toBe('tok-repo');
    const omitted = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo' }, 's1', 'a');
    expect(omitted.env.BOSUN_CRED_GIT_TOKEN).toBe('tok-repo');
    const dash = await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: 'https://github.com/my-org/my-repo', credential: '-' }, 's1', 'a');
    expect(dash.env.BOSUN_CRED_GIT_TOKEN).toBe('tok-repo');
  });

  it('does not resolve (or even look up) a credential when the source has no URL', async () => {
    const before = h.sql.length;
    expect(await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: '-' }, 's1', 'a')).toEqual({ env: {}, secrets: [] });
    // Even a named entry is ignored for an editor source, not an error.
    expect(await resolveCredentialUses('pkg', kinds, [{ kind: 'git', entry: 'credential', url: 'repo' }], { repo: '-', credential: 'org' }, 's1', 'a')).toEqual({ env: {}, secrets: [] });
    expect(h.sql.length).toBe(before);
  });

  it('falls back to the only destination of a server when none is marked default, and refuses to guess between two', async () => {
    add('only', backup, { repository: '/srv/only' }, { password: 'pw' }, ['s1'], false);
    const use = [{ kind: 'backup_destination', entry: 'destination', default: true }];
    const only = await resolveCredentialUses('pkg', kinds, use, { destination: 'auto' }, 's1', 'a');
    expect(only.env.BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY).toBe('/srv/only');
    expect(only.env.BOSUN_CRED_BACKUP_DESTINATION_NAME).toBe('only');
    add('second', backup, { repository: '/srv/second' }, { password: 'pw' }, ['s1'], false);
    await expect(resolveCredentialUses('pkg', kinds, use, { destination: 'auto' }, 's1', 'a')).rejects.toThrow(/No backup destination is set for this server/);
  });

  it('picks the backup destination from the parameter, or the server default', async () => {
    add('nas', backup, { repository: '/srv/backups' }, { password: 'pw' }, ['s1'], true);
    add('other', backup, { repository: '/srv/other' }, { password: 'pw2' }, ['s2'], true);
    const auto = await resolveCredentialUses('pkg', kinds, [{ kind: 'backup_destination', entry: 'destination', default: true }], { destination: 'auto' }, 's1', 'a');
    expect(auto.env).toEqual({ BOSUN_CRED_BACKUP_DESTINATION_ID: 'nas', BOSUN_CRED_BACKUP_DESTINATION_NAME: 'nas', BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY: '/srv/backups', BOSUN_CRED_BACKUP_DESTINATION_PASSWORD: 'pw' });
    const chosen = await resolveCredentialUses('pkg', kinds, [{ kind: 'backup_destination', entry: 'destination', default: true }], { destination: 'other' }, 's2', 'a');
    expect(chosen.env.BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY).toBe('/srv/other');
    await expect(resolveCredentialUses('pkg', kinds, [{ kind: 'backup_destination', entry: 'destination', default: true }], { destination: 'auto' }, 's3', 'a')).rejects.toThrow(/No backup destination is set for this server/);
  });
});

describe('migrating the legacy package secrets', () => {
  beforeEach(() => {
    h.packages = [{ id: 'docker', manifest: { credentials: kinds } }];
    h.servers = ['s1', 's2'];
  });

  it('creates the Git entries and one default backup destination for every server of the package, then deletes the secrets', async () => {
    ps.legacy = { git_token: 'tok-A', git_credentials: 'gitlab.com=glpat-B', backup_repository: 'sftp:nas:/repo', backup_password: 'pw' };
    await migratePackageCredentials();
    expect(h.rows.map(r => r.id)).toEqual(['mig_git_github_migrated', 'mig_git_gitlab_com', 'mig_backup_destination_backups_migrated']);
    expect(h.rows.find(r => r.id === 'mig_backup_destination_backups_migrated')).toMatchObject({ is_default: 1, servers: '["s1","s2"]' });
    expect(ps.deleted.sort()).toEqual(['backup_password', 'backup_repository', 'git_credentials', 'git_token']);
    const logs: string[] = [];
    void logs;
  });

  it('picks up a legacy secret that is still present after an earlier run saw no credential kinds', async () => {
    // The upgrade with the credential kinds lands later (a deferred bundled upgrade): the first run had nothing to do.
    h.packages = [{ id: 'docker', manifest: { credentials: [] } }];
    ps.legacy = { git_token: 'tok-A' };
    await migratePackageCredentials();
    expect(h.rows).toHaveLength(0);
    h.packages = [{ id: 'docker', manifest: { credentials: kinds } }];
    await migratePackageCredentials();
    expect(h.rows.map(r => r.name)).toEqual(['GitHub (migrated)']);
    expect(ps.deleted).toEqual(['git_token']);
  });

  it('finishes the cleanup when the entry exists but the legacy secret does not (a run that stopped between)', async () => {
    ps.legacy = { git_token: 'tok-A' };
    add('mig_git_github_migrated', git, { host: 'github.com' }, { token: 'tok-A' });
    h.rows[0].package_id = 'docker';
    await migratePackageCredentials();
    expect(h.rows).toHaveLength(1);
    expect(ps.deleted).toEqual(['git_token']);
  });

  it('is idempotent: a second run adds nothing and the secrets are gone', async () => {
    ps.legacy = { git_token: 'tok-A' };
    await migratePackageCredentials();
    const first = h.rows.length;
    await migratePackageCredentials();
    expect(h.rows).toHaveLength(first);
    expect(ps.deleted).toEqual(['git_token']);
  });

  it('leaves a half-filled destination editable by keeping its legacy secrets', async () => {
    ps.legacy = { backup_repository: 'sftp:nas:/repo' };
    await migratePackageCredentials();
    expect(h.rows).toHaveLength(0);
    expect(ps.deleted).toEqual([]);
  });

  it('logs the names it migrated and never a value', async () => {
    ps.legacy = { git_token: 'tok-SECRET-A', backup_repository: '/srv/x', backup_password: 'pw-SECRET' };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migratePackageCredentials();
    const text = log.mock.calls.flat().join(' ');
    log.mockRestore();
    expect(text).toContain('GitHub (migrated)');
    expect(text).not.toContain('tok-SECRET-A');
    expect(text).not.toContain('pw-SECRET');
  });
});
