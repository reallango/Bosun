import { describe, it, expect } from 'vitest';
import {
  credentialEnvName, defaultCredentialForServer, matchCredentialByUrl, parseHostList, parseRepositoryUrl,
  planCredentialMigration, validateCredentialKinds, validateCredentialMeta, validateCredentialValues,
  type CredentialKindDef, type MatchableCredential,
} from './credentials-schema';

const own = new Set(['docker.credentials', 'docker.backup_config', 'docker.manage']);
const secrets = new Set(['git_token', 'git_credentials', 'backup_repository', 'backup_password']);
const rawKinds = [
  {
    id: 'git', label: 'Git access', permission: 'docker.credentials',
    fields: [
      { id: 'host', label: 'Host', type: 'string', public: true, pattern: '^[a-z0-9.-]+$' },
      { id: 'scope', label: 'Owner or repository', type: 'string', public: true, optional: true },
      { id: 'username', label: 'Username', type: 'string', public: true, optional: true },
      { id: 'token', type: 'secret' },
    ],
    match: { url: 'host+scope' }, servers: 'optional',
    migrate: [
      { name: 'GitHub (migrated)', fields: { host: 'literal:github.com', token: 'secret:git_token' } },
      { name: 'Git ({host})', host_list: { secret: 'git_credentials', hostField: 'host', tokenField: 'token', usernameField: 'username' } },
    ],
  },
  {
    id: 'backup_destination', label: 'Backup destination', permission: 'docker.backup_config',
    fields: [
      { id: 'repository', type: 'string', public: true },
      { id: 'password', type: 'secret' },
      { id: 'credentials', type: 'secret', optional: true },
    ],
    servers: 'required', default_per_server: true,
    migrate: [{ name: 'Backups (migrated)', default_for_package_servers: true, fields: { repository: 'secret:backup_repository', password: 'secret:backup_password' } }],
  },
];

const kinds = (raw: unknown = rawKinds): CredentialKindDef[] => {
  const r = validateCredentialKinds(raw, own, secrets);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const git = () => kinds().find(k => k.id === 'git')!;
const backup = () => kinds().find(k => k.id === 'backup_destination')!;

const entry = (id: string, host: string, scope: string, extra: Partial<MatchableCredential> = {}): MatchableCredential => ({
  id, name: id, fields: { host, scope }, servers: [], isDefault: false, ...extra,
});

describe('validateCredentialKinds', () => {
  it('accepts the kinds the Docker package declares and keeps their public/secret split', () => {
    const [g, b] = kinds();
    expect(g).toMatchObject({ id: 'git', permission: 'docker.credentials', viewPermission: 'docker.credentials', servers: 'optional', match: { url: 'host+scope' } });
    expect(g.fields.map(f => [f.id, f.type, f.public])).toEqual([['host', 'string', true], ['scope', 'string', true], ['username', 'string', true], ['token', 'secret', false]]);
    expect(b).toMatchObject({ servers: 'required', defaultPerServer: true });
    expect(b.migrate[0]).toMatchObject({ name: 'Backups (migrated)', defaultForPackageServers: true });
  });

  it('allows no credentials at all', () => {
    expect(validateCredentialKinds(undefined, own)).toEqual({ ok: true, value: [] });
  });

  it('refuses a permission the package does not declare, a public secret and a match without host/scope', () => {
    const bad = (patch: (k: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(rawKinds)) as Record<string, unknown>[];
      patch(copy[0]);
      return validateCredentialKinds(copy, own, secrets);
    };
    expect(bad(k => { k.permission = 'other.permission'; })).toMatchObject({ ok: false });
    expect(bad(k => { (k.fields as Record<string, unknown>[])[3].public = true; })).toMatchObject({ ok: false });
    expect(bad(k => { delete (k.fields as Record<string, unknown>[])[0]; })).toMatchObject({ ok: false });
  });

  it('refuses a migration that names an undeclared secret or a host_list field that is not a secret', () => {
    const copy = JSON.parse(JSON.stringify(rawKinds)) as Record<string, unknown>[];
    (copy[0].migrate as Record<string, unknown>[])[0].fields = { host: 'literal:github.com', token: 'secret:nope' };
    expect(validateCredentialKinds(copy, own, secrets)).toMatchObject({ ok: false });
    const copy2 = JSON.parse(JSON.stringify(rawKinds)) as Record<string, unknown>[];
    (copy2[0].migrate as Record<string, unknown>[])[1].host_list = { secret: 'git_credentials', hostField: 'host', tokenField: 'username' };
    expect(validateCredentialKinds(copy2, own, secrets)).toMatchObject({ ok: false });
  });

  it('requires at least one server for a "required" kind and a value for a non-optional field', () => {
    expect(validateCredentialMeta(backup(), 'Backups', [])).toMatchObject({ ok: false });
    expect(validateCredentialMeta(backup(), 'Backups', ['s1'])).toMatchObject({ ok: true, value: { servers: ['s1'] } });
    expect(validateCredentialValues(git(), { fields: { host: 'github.com' }, secrets: { token: 'x' } })).toMatchObject({ ok: true });
    expect(validateCredentialValues(git(), { fields: { host: 'github.com' }, secrets: {} })).toMatchObject({ ok: false });
    expect(validateCredentialValues(git(), { fields: { host: 'GitHub com' }, secrets: { token: 'x' } })).toMatchObject({ ok: false });
  });
});

describe('credentialEnvName', () => {
  it('is BOSUN_CRED_<KIND>_<FIELD>', () => {
    expect(credentialEnvName('git', 'token')).toBe('BOSUN_CRED_GIT_TOKEN');
    expect(credentialEnvName('backup_destination', 'repository')).toBe('BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY');
  });
});

describe('URL matching', () => {
  it('parses an https repository URL into its host (with port) and path', () => {
    expect(parseRepositoryUrl('https://GitHub.com/my-org/my-repo.git')).toEqual({ host: 'github.com', path: ['my-org', 'my-repo.git'] });
    expect(parseRepositoryUrl('https://git.lan:3000/o/r')).toEqual({ host: 'git.lan:3000', path: ['o', 'r'] });
    expect(parseRepositoryUrl('http://github.com/o/r')).toBeNull();
    expect(parseRepositoryUrl('https://github.com')).toBeNull();
  });

  it('picks the whole host, the owner, then the repository: the longest scope wins', () => {
    const all = entry('host', 'github.com', '');
    const org = entry('org', 'github.com', 'my-org');
    const repo = entry('repo', 'github.com', 'my-org/my-repo');
    const list = [all, org, repo];
    expect(matchCredentialByUrl(list, 'https://github.com/my-org/my-repo')!.id).toBe('repo');
    expect(matchCredentialByUrl(list, 'https://github.com/my-org/other')!.id).toBe('org');
    expect(matchCredentialByUrl(list, 'https://github.com/someone/other')!.id).toBe('host');
  });

  it('never crosses hosts, and returns null when nothing matches', () => {
    const list = [entry('gh', 'github.com', ''), entry('lan', 'git.lan:3000', 'o')];
    expect(matchCredentialByUrl(list, 'https://gitlab.com/o/r')).toBeNull();
    expect(matchCredentialByUrl(list, 'https://git.lan:3000/o/r')!.id).toBe('lan');
    expect(matchCredentialByUrl(list, 'https://git.lan/o/r')).toBeNull();   // another port is another host
  });

  it('prefers a server-specific entry at the same scope', () => {
    const all = entry('all', 'github.com', 'my-org');
    const mine = entry('mine', 'github.com', 'my-org', { servers: ['s1'] });
    expect(matchCredentialByUrl([all, mine], 'https://github.com/my-org/r')!.id).toBe('mine');
  });
});

describe('defaultCredentialForServer', () => {
  it('returns the default entry the server may use, never one scoped to another server', () => {
    const a = entry('a', 'nas', '', { servers: ['s1'], isDefault: true });
    const b = entry('b', 'nas', '', { servers: ['s2'], isDefault: true });
    expect(defaultCredentialForServer([a, b], 's1')!.id).toBe('a');
    expect(defaultCredentialForServer([a, b], 's3')).toBeNull();
  });
});

describe('planCredentialMigration', () => {
  it('turns git_token into a whole-host entry and every host=token item into one entry per host', () => {
    const [g] = kinds().filter(k => k.id === 'git');
    const planned = planCredentialMigration(g, { git_token: 'tok-A', git_credentials: 'git.lan:3000=bosun:s3cret, gitlab.com=glpat-B' }, []);
    expect(planned.map(p => [p.id, p.name, p.publicFields.host, p.publicFields.scope, p.secretFields.token])).toEqual([
      ['mig_git_github_migrated', 'GitHub (migrated)', 'github.com', undefined, 'tok-A'],
      ['mig_git_git_lan_3000', 'Git (git.lan:3000)', 'git.lan:3000', undefined, 's3cret'],
      ['mig_git_gitlab_com', 'Git (gitlab.com)', 'gitlab.com', undefined, 'glpat-B'],
    ]);
    expect(planned[1].publicFields.username).toBe('bosun');
  });

  it('makes the backup destination the default for every server of the package, once', () => {
    const b = backup();
    const planned = planCredentialMigration(b, { backup_repository: 'sftp:user@nas:/repo', backup_password: 'pw' }, ['s1', 's2', 's1']);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ name: 'Backups (migrated)', isDefault: true, servers: ['s1', 's2'], publicFields: { repository: 'sftp:user@nas:/repo' }, secretFields: { password: 'pw' } });
  });

  it('migrates nothing from a half-filled configuration', () => {
    expect(planCredentialMigration(backup(), { backup_repository: 'sftp:x', backup_password: '' }, ['s1'])).toEqual([]);
    expect(planCredentialMigration(git(), { git_token: '  ' }, [])).toEqual([]);
  });

  it('is deterministic: the same legacy values plan the same ids', () => {
    const a = planCredentialMigration(git(), { git_token: 'x' }, []);
    const b = planCredentialMigration(git(), { git_token: 'x' }, []);
    expect(a.map(p => p.id)).toEqual(b.map(p => p.id));
  });
});

describe('parseHostList', () => {
  it('reads host=token and host=user:token, separated by spaces, commas or semicolons', () => {
    expect(parseHostList('a.com=x b.com=u:t;c.com=y,z.com=v')).toEqual([
      { host: 'a.com', token: 'x' }, { host: 'b.com', username: 'u', token: 't' }, { host: 'c.com', token: 'y' }, { host: 'z.com', token: 'v' },
    ]);
    expect(parseHostList('not a list')).toEqual([]);
  });
});
