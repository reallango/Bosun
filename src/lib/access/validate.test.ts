import { describe, it, expect } from 'vitest';
import type { PermissionDef } from '@/lib/permissions/catalog';
import { audienceFor, describeRequest, validateRequestInput } from './validate';

const pkg = (id: string, over: Partial<PermissionDef> = {}): PermissionDef => ({
  id, label: id, description: '', group: 'Docker', defaultLevel: 'operator', risk: 'medium', scope: 'server', source: 'package:docker', ...over,
});
const defs = [pkg('docker.manage', { label: 'Manage containers' }), pkg('docker.privileged', { risk: 'high', defaultLevel: 'admin' })];

describe('access request input', () => {
  it('accepts a grant for one server, limited to a stack, for some hours', () => {
    expect(validateRequestInput({ kind: 'grant', permission: 'docker.manage', server_id: 's1', resource: { kind: 'stack', name: 'test-ai' }, duration_hours: 8, reason: ' tests ' }, defs))
      .toEqual({ ok: true, value: { kind: 'grant', permission: 'docker.manage', serverId: 's1', resource: { kind: 'stack', name: 'test-ai' }, durationHours: 8, reason: 'tests' } });
    // permanent, all servers, no limit
    expect(validateRequestInput({ kind: 'grant', permission: 'docker.manage' }, defs))
      .toEqual({ ok: true, value: { kind: 'grant', permission: 'docker.manage', serverId: null, resource: null, durationHours: null, reason: null } });
  });

  it('accepts a one-time action with its parameters frozen', () => {
    const r = validateRequestInput({ kind: 'one_time', server_id: 's1', widget_type: 'docker_containers', action_id: 'stack_deploy', params: { name: 'test-ai', yaml: 'x' } }, defs);
    expect(r).toEqual({ ok: true, value: { kind: 'one_time', serverId: 's1', widgetType: 'docker_containers', actionId: 'stack_deploy', params: { name: 'test-ai', yaml: 'x' }, reason: null } });
  });

  it('refuses what cannot be granted or run', () => {
    const bad = (b: unknown) => validateRequestInput(b, defs).ok;
    expect(bad(null)).toBe(false);
    expect(bad({ kind: 'everything' })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'nope' })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'dashboards.edit', server_id: 's1' })).toBe(false); // global permission
    expect(bad({ kind: 'grant', permission: 'power.restart', server_id: 's1', resource: { kind: 'stack', name: 'x' } })).toBe(false); // core: no limit
    expect(bad({ kind: 'grant', permission: 'docker.manage', resource: { kind: 'stack', name: 'x' } })).toBe(false); // a limit needs a server
    expect(bad({ kind: 'grant', permission: 'docker.manage', server_id: 's1', resource: { kind: 'stack', name: '../x' } })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'docker.manage', duration_hours: 0 })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'docker.manage', duration_hours: 1.5 })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'docker.manage', duration_hours: 99999 })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'docker.manage', reason: 'x'.repeat(501) })).toBe(false);
    expect(bad({ kind: 'grant', permission: 'docker.manage', server_id: 'a b' })).toBe(false);
    expect(bad({ kind: 'one_time', widget_type: 'docker_containers', action_id: 'stack_deploy' })).toBe(false); // no server
    expect(bad({ kind: 'one_time', server_id: 's1', widget_type: 'Docker!', action_id: 'x' })).toBe(false);
    expect(bad({ kind: 'one_time', server_id: 's1', widget_type: 'd', action_id: 'x', params: [] })).toBe(false);
    expect(bad({ kind: 'one_time', server_id: 's1', widget_type: 'd', action_id: 'x', params: { y: 'z'.repeat(80_000) } })).toBe(false);
  });

  it('sends high-risk and Full-access-only permissions to Full access, and words the request plainly', () => {
    expect(audienceFor(defs[0])).toBe('operator');
    expect(audienceFor(defs[1])).toBe('admin');
    expect(describeRequest({ kind: 'grant', permissionLabel: 'Manage containers', serverName: 'Dock-Ubuntu', resource: { kind: 'stack', name: 'test-ai' }, durationHours: 8 }))
      .toBe('"Manage containers" on Dock-Ubuntu (stack test-ai) for 8 hours');
    expect(describeRequest({ kind: 'grant', permissionLabel: 'Manage containers', serverName: null, resource: null, durationHours: null }))
      .toBe('"Manage containers" on all servers permanently');
    expect(describeRequest({ kind: 'one_time', permissionLabel: 'x', serverName: 'Dock-Ubuntu', resource: { kind: 'stack', name: 'test-ai' }, durationHours: null, actionLabel: 'Deploy stack' }))
      .toBe('run "Deploy stack" once on Dock-Ubuntu (stack test-ai)');
  });
});
