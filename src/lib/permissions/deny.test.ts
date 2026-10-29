import { describe, it, expect } from 'vitest';
import { allowedServerIds, grantsAllow, levelGrants, type Grant, type ServerContext } from './evaluate';
import { permissionsForLevel, impliedSet } from './catalog';
import { validateGrants } from './validate';

const s1: ServerContext = { id: 's1', groupIds: ['g1'] };
const s2: ServerContext = { id: 's2', groupIds: [] };
const s3: ServerContext = { id: 's3', groupIds: ['g1'] };
const servers = [s1, s2, s3];

describe('servers.view and levels', () => {
  it('every level holds it by default, so nobody loses sight of servers unless a group denies it', () => {
    for (const level of ['viewer', 'operator', 'admin']) {
      expect(permissionsForLevel(level).some(p => p.id === 'servers.view'), level).toBe(true);
      expect(grantsAllow(levelGrants(level), 'servers.view', s1)).toBe(true);
    }
    // Viewers still hold nothing else by default.
    expect(permissionsForLevel('viewer').map(p => p.id)).toEqual(['servers.view']);
  });
});

describe('deny grants', () => {
  const base = levelGrants('operator');

  it('a deny for one server hides just that server, whatever the level allows', () => {
    const grants: Grant[] = [...base, { permission: 'servers.view', scope: { type: 'server', id: 's2' }, effect: 'deny' }];
    expect(grantsAllow(grants, 'servers.view', s1)).toBe(true);
    expect(grantsAllow(grants, 'servers.view', s2)).toBe(false);
    expect(allowedServerIds(grants, 'servers.view', servers)).toEqual(['s1', 's3']);
  });

  it('a deny for a server group, or for everything, works the same way', () => {
    const grp: Grant[] = [...base, { permission: 'servers.view', scope: { type: 'server_group', id: 'g1' }, effect: 'deny' }];
    expect(allowedServerIds(grp, 'servers.view', servers)).toEqual(['s2']);
    const all: Grant[] = [...base, { permission: 'servers.view', scope: { type: 'all' }, effect: 'deny' }];
    expect(allowedServerIds(all, 'servers.view', servers)).toEqual([]);
    expect(grantsAllow(all, 'servers.view', null)).toBe(false);
  });

  it('a deny beats an allow from another group', () => {
    const grants: Grant[] = [
      ...base,
      { permission: 'power.restart', scope: { type: 'all' } },
      { permission: 'power.restart', scope: { type: 'server', id: 's1' }, effect: 'deny' },
    ];
    expect(grantsAllow(grants, 'power.restart', s1)).toBe(false);
    expect(grantsAllow(grants, 'power.restart', s2)).toBe(true);
  });

  it('denying a permission also denies the ones that include it', () => {
    expect(impliedSet('updates.install').has('updates.check')).toBe(true);
    const grants: Grant[] = [...base, { permission: 'updates.check', scope: { type: 'all' }, effect: 'deny' }];
    expect(grantsAllow(grants, 'updates.check', s1)).toBe(false);
    expect(grantsAllow(grants, 'updates.install', s1)).toBe(false);   // install implies check
    expect(grantsAllow(grants, 'power.restart', s1)).toBe(true);       // unrelated
  });

  it('allow grants without an effect behave as before, and a server-scoped deny does not affect "no server" checks', () => {
    expect(grantsAllow([{ permission: 'power.restart', scope: { type: 'all' } }], 'power.restart', s1)).toBe(true);
    const grants: Grant[] = [...base, { permission: 'dashboards.edit', scope: { type: 'server', id: 's1' }, effect: 'deny' }];
    expect(grantsAllow(grants, 'dashboards.edit', null)).toBe(true);
  });
});

describe('validateGrants with effects', () => {
  it('accepts allow and deny and keeps deny', () => {
    const r = validateGrants([{ permission: 'servers.view', scope: { type: 'server', id: 's2' }, effect: 'deny' }, { permission: 'power.restart', scope: { type: 'all' } }]);
    expect(r.ok && r.value).toEqual([
      { permission: 'servers.view', scope: { type: 'server', id: 's2' }, effect: 'deny' },
      { permission: 'power.restart', scope: { type: 'all' } },
    ]);
  });
  it('rejects unknown effects and a permission both allowed and denied for the same servers', () => {
    expect(validateGrants([{ permission: 'power.restart', effect: 'maybe' }]).ok).toBe(false);
    const both = validateGrants([{ permission: 'power.restart', effect: 'deny' }, { permission: 'power.restart' }]);
    expect(both.ok).toBe(false);
    // Different scopes may differ.
    expect(validateGrants([{ permission: 'power.restart', effect: 'deny', scope: { type: 'server', id: 'a' } }, { permission: 'power.restart' }]).ok).toBe(true);
  });
});
