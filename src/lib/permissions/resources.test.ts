import { describe, it, expect } from 'vitest';
import { grantsAllow, allowedServerIds, resourceCovers, type Grant } from './evaluate';
import { validateGrants } from './validate';
import type { PermissionDef } from './catalog';
import { filterRows, rowResource } from '@/lib/widgets/runtime/resources';

const pkg = (id: string, over: Partial<PermissionDef> = {}): PermissionDef => ({
  id, label: id, description: '', group: 'Docker', defaultLevel: 'admin', risk: 'medium', scope: 'server', source: 'package:docker', ...over,
});
const defs = [pkg('docker.manage'), pkg('docker.view', { defaultLevel: 'viewer' }), pkg('docker.delete')];
const nuc = { id: 'nuc', groupIds: [] };
const dock = { id: 'dock', groupIds: [] };
const stack = (name: string) => ({ kind: 'stack' as const, name });
const container = (name: string, stack: string | null = null) => ({ kind: 'container' as const, name, stack });

describe('grants limited to a stack or container', () => {
  const g: Grant[] = [{ permission: 'docker.manage', scope: { type: 'server', id: 'dock' }, resource: { kind: 'stack', name: 'test-ai' } }];

  it('allow only that stack, its containers, on that server', () => {
    expect(grantsAllow(g, 'docker.manage', dock, defs, { resource: stack('test-ai') })).toBe(true);
    expect(grantsAllow(g, 'docker.manage', dock, defs, { resource: container('test-ai-web-1', 'test-ai') })).toBe(true);
    expect(grantsAllow(g, 'docker.manage', dock, defs, { resource: stack('bosun') })).toBe(false);
    expect(grantsAllow(g, 'docker.manage', dock, defs, { resource: container('bosun', 'bosun') })).toBe(false);
    // a container whose stack is unknown is not covered by a stack grant
    expect(grantsAllow(g, 'docker.manage', dock, defs, { resource: container('test-ai-web-1') })).toBe(false);
    expect(grantsAllow(g, 'docker.manage', nuc, defs, { resource: stack('test-ai') })).toBe(false);
    // nothing about one stack (pull an image, prune): a limited grant does not count
    expect(grantsAllow(g, 'docker.manage', dock, defs)).toBe(false);
    // ...but it does show the controls for that server
    expect(allowedServerIds(g, 'docker.manage', [nuc, dock], defs)).toEqual(['dock']);
  });

  it('match a prefix with *, and a container limit only that container', () => {
    const p: Grant[] = [
      { permission: 'docker.manage', scope: { type: 'all' }, resource: { kind: 'stack', name: 'test-*' } },
      { permission: 'docker.delete', scope: { type: 'all' }, resource: { kind: 'container', name: 'scratch' } },
    ];
    expect(grantsAllow(p, 'docker.manage', nuc, defs, { resource: stack('test-ai') })).toBe(true);
    expect(grantsAllow(p, 'docker.manage', nuc, defs, { resource: stack('prod') })).toBe(false);
    expect(grantsAllow(p, 'docker.delete', nuc, defs, { resource: container('scratch', 'x') })).toBe(true);
    expect(grantsAllow(p, 'docker.delete', nuc, defs, { resource: stack('scratch') })).toBe(false);
    expect(resourceCovers(undefined, null)).toBe(true);
  });

  it('a limited deny blocks only that resource; an unlimited deny blocks everything', () => {
    const d: Grant[] = [
      { permission: 'docker.manage', scope: { type: 'all' } },
      { permission: 'docker.manage', scope: { type: 'all' }, effect: 'deny', resource: { kind: 'stack', name: 'bosun' } },
    ];
    expect(grantsAllow(d, 'docker.manage', nuc, defs, { resource: stack('web') })).toBe(true);
    expect(grantsAllow(d, 'docker.manage', nuc, defs, { resource: container('bosun', 'bosun') })).toBe(false);
    expect(allowedServerIds(d, 'docker.manage', [nuc], defs)).toEqual(['nuc']);
    const all: Grant[] = [...d, { permission: 'docker.manage', scope: { type: 'server', id: 'nuc' }, effect: 'deny' }];
    expect(grantsAllow(all, 'docker.manage', nuc, defs, { resource: stack('web') })).toBe(false);
  });

  it('stop counting once expired', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    const e: Grant[] = [{ permission: 'docker.manage', scope: { type: 'all' }, resource: { kind: 'stack', name: 'x' }, expiresAt: '2026-06-01T00:00:01Z' }];
    expect(grantsAllow(e, 'docker.manage', nuc, defs, { resource: stack('x'), now })).toBe(true);
    expect(grantsAllow(e, 'docker.manage', nuc, defs, { resource: stack('x'), now: now + 2000 })).toBe(false);
  });
});

describe('validating limited and expiring grants', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  it('accepts a stack/container limit on a package permission, and a future expiry within a year', () => {
    const r = validateGrants([{ permission: 'docker.manage', scope: { type: 'all' }, resource: { kind: 'stack', name: 'test-*' }, expiresAt: '2026-06-02T00:00:00Z' }], defs, now);
    expect(r).toEqual({ ok: true, value: [{ permission: 'docker.manage', scope: { type: 'all' }, resource: { kind: 'stack', name: 'test-*' }, expiresAt: '2026-06-02T00:00:00.000Z' }] });
    // the same permission for two stacks is two grants, not a duplicate
    const two = validateGrants([
      { permission: 'docker.manage', resource: { kind: 'stack', name: 'a' } },
      { permission: 'docker.manage', resource: { kind: 'stack', name: 'b' } },
    ], defs, now);
    expect(two.ok && two.value.length).toBe(2);
  });
  it('refuses limits on core permissions, odd names and kinds, and past or far expiries', () => {
    const bad = (item: Record<string, unknown>, d = defs) => validateGrants([item], d, now);
    expect(bad({ permission: 'power.restart', resource: { kind: 'stack', name: 'x' } })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', resource: { kind: 'volume', name: 'x' } })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', resource: { kind: 'stack', name: '../x' } })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', resource: { kind: 'stack', name: 'a*b' } })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', expiresAt: '2026-05-01T00:00:00Z' })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', expiresAt: '2028-06-01T00:00:00Z' })).toMatchObject({ ok: false });
    expect(bad({ permission: 'docker.manage', expiresAt: 'soon' })).toMatchObject({ ok: false });
  });
});

describe('filtering rows for a limited view', () => {
  const fields = { container: 'name', stack: 'compose' };
  const rows = [
    { name: 'bosun', compose: 'bosun' },
    { name: 'test-ai-web-1', compose: 'test-ai' },
    { name: 'loose', compose: '' },
  ];
  it('keeps the rows of the allowed stacks and containers only', () => {
    const allow = (r: { kind: string; name: string; stack?: string | null }) => r.kind === 'container' && (r.stack === 'test-ai' || r.name === 'loose');
    expect(filterRows(rows, fields, allow)).toEqual([rows[1], rows[2]]);
    expect(filterRows(rows, fields, 'all')).toBe(rows);
    expect(filterRows({ rows, other: 1 }, fields, () => false)).toEqual({ rows: [], other: 1 });
    expect(filterRows('text', fields, () => true)).toEqual([]);
    expect(rowResource({ name: 'x' }, { stack: 'name' })).toEqual({ kind: 'stack', name: 'x' });
  });
});
