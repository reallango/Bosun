import { describe, it, expect } from 'vitest';
import { validateGrants, validateGroupIds, validateGroupInput, validateServerGroupInput, MAX_GRANTS, MAX_NAME } from './validate';

describe('validateGrants', () => {
  it('accepts known permissions with each scope and normalises a missing scope to all', () => {
    const r = validateGrants([
      { permission: 'power.restart', scope: { type: 'server', id: 's1' } },
      { permission: 'power.restart', scope: { type: 'server_group', id: 'lab' } },
      { permission: 'docker.logs', scope: { type: 'all' } },
      { permission: 'updates.check' },
    ]);
    expect(r).toEqual({ ok: true, value: [
      { permission: 'power.restart', scope: { type: 'server', id: 's1' } },
      { permission: 'power.restart', scope: { type: 'server_group', id: 'lab' } },
      { permission: 'docker.logs', scope: { type: 'all' } },
      { permission: 'updates.check', scope: { type: 'all' } },
    ] });
  });

  it('drops exact duplicates but keeps the same permission on different scopes', () => {
    const r = validateGrants([
      { permission: 'power.wake', scope: { type: 'server', id: 's1' } },
      { permission: 'power.wake', scope: { type: 'server', id: 's1' } },
      { permission: 'power.wake', scope: { type: 'server', id: 's2' } },
    ]);
    expect(r.ok && r.value).toHaveLength(2);
  });

  it('rejects unknown permissions, bad shapes and unknown scopes', () => {
    expect(validateGrants([{ permission: 'power.reboot' }])).toMatchObject({ ok: false, error: expect.stringContaining('Unknown permission') });
    expect(validateGrants('nope')).toMatchObject({ ok: false });
    expect(validateGrants([null])).toMatchObject({ ok: false });
    expect(validateGrants([{ permission: 'power.wake', scope: { type: 'planet', id: 'x' } }])).toMatchObject({ ok: false, error: expect.stringContaining('Unknown scope') });
    expect(validateGrants([{ permission: 'power.wake', scope: { type: 'server' } }])).toMatchObject({ ok: false });
  });

  it('refuses a per-server scope on a permission that is not tied to a server', () => {
    const r = validateGrants([{ permission: 'dashboards.edit', scope: { type: 'server', id: 's1' } }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('only be granted for everything') });
    expect(validateGrants([{ permission: 'dashboards.edit', scope: { type: 'all' } }]).ok).toBe(true);
  });

  it('accepts permissions registered by an installed widget, and only then', () => {
    const extra = [{ id: 'pkg.thing.run', label: 'Run a thing', description: 'Runs the thing on the host.', group: 'Thing', source: 'package:thing',
      defaultLevel: 'operator' as const, risk: 'low' as const, scope: 'server' as const }];
    expect(validateGrants([{ permission: 'pkg.thing.run' }]).ok).toBe(false);
    expect(validateGrants([{ permission: 'pkg.thing.run', scope: { type: 'server', id: 's1' } }], extra).ok).toBe(true);
  });

  it('limits the number of grants', () => {
    const many = Array.from({ length: MAX_GRANTS + 1 }, (_, i) => ({ permission: 'power.wake', scope: { type: 'server', id: `s${i}` } }));
    expect(validateGrants(many)).toMatchObject({ ok: false });
  });
});

describe('validateGroupInput', () => {
  it('requires a name when creating, not when updating', () => {
    expect(validateGroupInput({}, [], true)).toMatchObject({ ok: false });
    expect(validateGroupInput({ description: 'x' }, [], false)).toEqual({ ok: true, value: { description: 'x' } });
  });

  it('trims, bounds and defaults', () => {
    expect(validateGroupInput({ name: '  Help desk  ' }, [], true)).toEqual({ ok: true, value: { name: 'Help desk', grants: [] } });
    expect(validateGroupInput({ name: 'x'.repeat(MAX_NAME + 1) }, [], true)).toMatchObject({ ok: false });
    expect(validateGroupInput({ name: 'a', description: '' }, [], false)).toEqual({ ok: true, value: { name: 'a', description: null } });
  });

  it('leaves grants alone on update unless given, and validates them when given', () => {
    expect(validateGroupInput({ name: 'a' }, [], false)).toEqual({ ok: true, value: { name: 'a' } });
    expect(validateGroupInput({ grants: [{ permission: 'nope' }] }, [], false)).toMatchObject({ ok: false });
    expect(validateGroupInput({ grants: [] }, [], false)).toEqual({ ok: true, value: { grants: [] } });
  });

  it('rejects a body that is not an object', () => {
    for (const body of [null, 'x', 5, []]) expect(validateGroupInput(body, [], true)).toMatchObject({ ok: false });
  });
});

describe('validateServerGroupInput', () => {
  it('validates members and removes duplicates', () => {
    expect(validateServerGroupInput({ name: 'Lab', server_ids: ['a', 'b', 'a'] }, true)).toEqual({ ok: true, value: { name: 'Lab', server_ids: ['a', 'b'] } });
    expect(validateServerGroupInput({ name: 'Lab', server_ids: [1] }, true)).toMatchObject({ ok: false });
    expect(validateServerGroupInput({ name: 'Lab' }, true)).toEqual({ ok: true, value: { name: 'Lab', server_ids: [] } });
    expect(validateServerGroupInput({ name: 'Lab' }, false)).toEqual({ ok: true, value: { name: 'Lab' } });
  });
});

describe('validateGroupIds', () => {
  it('accepts a list of ids and removes duplicates', () => {
    expect(validateGroupIds(['a', 'b', 'a'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(validateGroupIds([])).toEqual({ ok: true, value: [] });
    expect(validateGroupIds('a')).toMatchObject({ ok: false });
    expect(validateGroupIds([1])).toMatchObject({ ok: false });
  });
});
