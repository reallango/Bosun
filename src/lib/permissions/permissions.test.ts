import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CATALOG, fullCatalog, permissionDef, permissionsForLevel, satisfiers, type PermissionDef } from './catalog';
import { allowedServerIds, grantsAllow, levelGrants, type Grant, type ServerContext } from './evaluate';

const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const srv = (id: string, ...groupIds: string[]): ServerContext => ({ id, groupIds });
const all = (permission: string): Grant => ({ permission, scope: { type: 'all' } });
const onServer = (permission: string, id: string): Grant => ({ permission, scope: { type: 'server', id } });
const onGroup = (permission: string, id: string): Grant => ({ permission, scope: { type: 'server_group', id } });
const UPD: PermissionDef[] = [
  { id: 'updates.check', label: 'Check', description: 'Check for updates.', group: 'Updates', source: 'package:updates', defaultLevel: 'operator', risk: 'low', scope: 'server' },
  { id: 'updates.install', label: 'Install', description: 'Install updates.', group: 'Updates', source: 'package:updates', defaultLevel: 'operator', risk: 'high', scope: 'server', implies: ['updates.check'] },
];

describe('permission catalog', () => {
  it('has well-formed, unique ids and complete descriptions', () => {
    const ids = CATALOG.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of CATALOG) {
      expect(p.id).toMatch(ID_RE);
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.group.length).toBeGreaterThan(0);
      expect(['viewer', 'operator', 'admin']).toContain(p.defaultLevel);
      expect(['low', 'medium', 'high']).toContain(p.risk);
      expect(['server', 'global']).toContain(p.scope);
    }
  });

  it('only implies permissions that exist, and never itself', () => {
    for (const p of CATALOG) {
      for (const i of p.implies ?? []) {
        expect(permissionDef(i)).toBeDefined();
        expect(i).not.toBe(p.id);
      }
    }
  });

  it('marks everything that can run code or power a host off or on as high risk', () => {
    for (const id of ['power.restart', 'power.shutdown']) {
      expect(permissionDef(id)?.risk).toBe('high');
    }
  });
});

describe('access levels map onto permissions exactly as before', () => {
  it('Read only has no action permissions, only seeing servers (which a group can deny)', () => {
    expect(permissionsForLevel('viewer').map(p => p.id)).toEqual(['servers.view']);
    expect(permissionsForLevel('nonsense')).toEqual([]);
  });

  it('Read + actions has the operator permissions, and not the admin ones', () => {
    const ids = permissionsForLevel('operator').map(p => p.id);
    for (const id of ['power.wake', 'power.restart', 'power.shutdown', 'dashboards.edit']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('commands.run');
    expect(ids.every(id => ['viewer', 'operator'].includes(permissionDef(id)?.defaultLevel ?? ''))).toBe(true);
  });

  it('Full access has everything, including permissions registered later', () => {
    expect(permissionsForLevel('admin')).toHaveLength(CATALOG.length);
    const later: PermissionDef = { id: 'pkg.thing.run', label: 'Run a thing', description: 'Runs the thing on the host.', group: 'Thing',
      source: 'package:thing', defaultLevel: 'operator', risk: 'low', scope: 'server' };
    expect(permissionsForLevel('admin', [later]).map(p => p.id)).toContain('pkg.thing.run');
    expect(permissionsForLevel('operator', [later]).map(p => p.id)).toContain('pkg.thing.run');
    expect(permissionsForLevel('viewer', [later]).map(p => p.id)).toEqual(['servers.view']);
  });

  it('levelGrants are all-servers grants', () => {
    const g = levelGrants('operator');
    expect(g.length).toBeGreaterThan(5);
    expect(g.every(x => x.scope.type === 'all')).toBe(true);
  });
});

describe('satisfiers (implied permissions)', () => {
  it('install implies check, not the other way round', () => {
    expect(satisfiers('updates.check', UPD).has('updates.install')).toBe(true);
    expect(satisfiers('updates.install', UPD).has('updates.check')).toBe(false);
  });

  it('follows a chain of implications from registered definitions', () => {
    const extra: PermissionDef[] = [
      { id: 'x.a', label: 'Level A', description: 'Top of the chain.', group: 'X', source: 'package:x', defaultLevel: 'admin', risk: 'low', scope: 'server', implies: ['x.b'] },
      { id: 'x.b', label: 'Level B', description: 'Middle of the chain.', group: 'X', source: 'package:x', defaultLevel: 'admin', risk: 'low', scope: 'server', implies: ['x.c'] },
      { id: 'x.c', label: 'Level C', description: 'Bottom of the chain.', group: 'X', source: 'package:x', defaultLevel: 'admin', risk: 'low', scope: 'server' },
    ];
    expect([...satisfiers('x.c', extra)].sort()).toEqual(['x.a', 'x.b', 'x.c']);
  });
});

describe('grantsAllow', () => {
  it('an all-servers grant covers every server and the no-server case', () => {
    const g = [all('power.restart')];
    expect(grantsAllow(g, 'power.restart', srv('s1'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', null)).toBe(true);
    expect(grantsAllow(g, 'power.shutdown', srv('s1'))).toBe(false);
  });

  it('a per-server grant covers only that server', () => {
    const g = [onServer('power.restart', 's1')];
    expect(grantsAllow(g, 'power.restart', srv('s1'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', srv('s2'))).toBe(false);
    expect(grantsAllow(g, 'power.restart', null)).toBe(false);
  });

  it('a server-group grant covers members of the group', () => {
    const g = [onGroup('power.restart', 'lab')];
    expect(grantsAllow(g, 'power.restart', srv('s1', 'lab'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', srv('s1', 'lab', 'other'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', srv('s2', 'other'))).toBe(false);
    expect(grantsAllow(g, 'power.restart', srv('s3'))).toBe(false);
  });

  it('a permission that implies the requested one also counts, within its scope', () => {
    const g = [onServer('updates.install', 's1')];
    expect(grantsAllow(g, 'updates.check', srv('s1'), UPD)).toBe(true);
    expect(grantsAllow(g, 'updates.check', srv('s2'), UPD)).toBe(false);
  });

  it('grants combine (a person in several groups)', () => {
    const g = [onServer('power.restart', 's1'), onGroup('power.restart', 'lab'), all('servers.refresh')];
    expect(grantsAllow(g, 'power.restart', srv('s1'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', srv('s9', 'lab'))).toBe(true);
    expect(grantsAllow(g, 'power.restart', srv('s9'))).toBe(false);
    expect(grantsAllow(g, 'servers.refresh', srv('s9'))).toBe(true);
  });

  it('never allows an unknown permission, even with an all grant', () => {
    expect(grantsAllow([all('made.up')], 'made.up', srv('s1'))).toBe(false);
    expect(grantsAllow([all('power.restart')], 'power.reboot', srv('s1'))).toBe(false);
  });

  it('knows permissions registered by installed widgets', () => {
    const extra: PermissionDef[] = [{ id: 'pkg.thing.run', label: 'Run a thing', description: 'Runs the thing on the host.', group: 'Thing',
      source: 'package:thing', defaultLevel: 'operator', risk: 'low', scope: 'server' }];
    expect(grantsAllow([onServer('pkg.thing.run', 's1')], 'pkg.thing.run', srv('s1'))).toBe(false);          // not registered: unknown
    expect(grantsAllow([onServer('pkg.thing.run', 's1')], 'pkg.thing.run', srv('s1'), extra)).toBe(true);    // registered
  });

  it('a global permission is only granted by an all-servers grant', () => {
    expect(grantsAllow([all('dashboards.edit')], 'dashboards.edit', null)).toBe(true);
    expect(grantsAllow([onServer('dashboards.edit', 's1')], 'dashboards.edit', null)).toBe(false);
  });
});

describe('allowedServerIds', () => {
  const servers = [srv('s1', 'lab'), srv('s2'), srv('s3', 'lab')];
  it('returns * when granted everywhere', () => {
    expect(allowedServerIds([all('power.restart')], 'power.restart', servers)).toBe('*');
  });
  it('lists the servers a scoped grant reaches', () => {
    expect(allowedServerIds([onGroup('power.restart', 'lab'), onServer('power.restart', 's2')], 'power.restart', servers).sort()).toEqual(['s1', 's2', 's3']);
    expect(allowedServerIds([onServer('power.restart', 's2')], 'power.restart', servers)).toEqual(['s2']);
    expect(allowedServerIds([], 'power.restart', servers)).toEqual([]);
  });
});

describe('routes use real permission ids', () => {
  // Guards against a typo in `authorize(request, 'power.restrat')`, which would deny everyone but Full access.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(join(__dirname, '..', '..', 'app', 'api'));

  it('every authorize()/hasPermission() call names a permission in the catalog', () => {
    const known = new Set(fullCatalog().map(p => p.id));
    // Permissions provided by the bundled widget packages (e.g. docker.logs) are registered when they install.
    const widgetsRoot = join(__dirname, '..', '..', '..', 'widgets');
    for (const d of readdirSync(widgetsRoot)) {
      try { for (const p of JSON.parse(readFileSync(join(widgetsRoot, d, 'manifest.json'), 'utf8')).permissions ?? []) known.add(p.id); } catch { /* not a package folder */ }
    }
    const used: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\b(?:authorize|hasPermission)\(\s*[^,()]+,\s*'([a-z0-9_.]+)'/g)) used.push(m[1]);
    }
    for (const id of used) expect(known.has(id), `unknown permission "${id}" used in a route`).toBe(true);
  });
});
