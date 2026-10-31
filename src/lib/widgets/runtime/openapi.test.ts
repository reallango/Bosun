import { describe, it, expect } from 'vitest';
import { buildOpenApi } from './openapi';
import { validateWidgetSpec } from './spec';

const spec = (() => {
  const r = validateWidgetSpec({
    version: 1,
    data: { source: 'command', as: 'service', parse: 'jsonlines', command: 'docker ps', permission: 'dk.view' },
    view: { type: 'list', row: { title: '{name}', actions: ['restart'] } },
    actions: [
      { id: 'restart', label: 'Restart', permission: 'dk.control', as: 'service', command: 'docker restart {{name}}', confirm: { title: 'Restart {name}?' },
        params: { name: { type: 'string', pattern: '^[a-z]+$' } } },
      { id: 'prune', label: 'Prune', permission: 'dk.control', as: 'shell', command: 'echo ok' },
    ],
  }, ['dk.view', 'dk.control']);
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();

describe('buildOpenApi', () => {
  const doc = buildOpenApi([{ type: 'dk_w', packageId: 'dk', displayName: 'Docker', spec, permissionLabels: { 'dk.control': 'Control containers', 'dk.view': 'View containers' } }], 'https://b.example') as any;

  it('describes the fixed endpoints and one operation per action and data source', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers[0].url).toBe('https://b.example');
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    for (const p of ['/api/servers', '/api/servers/{serverId}/shell/exec', '/api/servers/{serverId}/terminal', '/api/servers/{serverId}/widget-data/dk_w',
      '/api/servers/{serverId}/widget-actions/dk_w/restart', '/api/servers/{serverId}/widget-actions/dk_w/prune']) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });

  it('documents parameters, confirmation, permission and account', () => {
    const op = doc.paths['/api/servers/{serverId}/widget-actions/dk_w/restart'].post;
    expect(op.operationId).toBe('widgetAction_dk_w_restart');
    expect(op['x-bosun-permission']).toBe('dk.control');
    expect(op['x-bosun-runs-as']).toBe('service');
    const schema = op.requestBody.content['application/json'].schema;
    expect(schema.required).toEqual(['params', 'confirm']);
    expect(schema.properties.params.properties.name).toMatchObject({ type: 'string', pattern: '^[a-z]+$', maxLength: 200 });
    expect(schema.properties.params.additionalProperties).toBe(false);
    expect(schema.properties.confirm.enum).toEqual([true]);
    expect(op.description).toMatch(/Control containers/);
  });

  it('has no request body for an action without parameters or confirmation', () => {
    const op = doc.paths['/api/servers/{serverId}/widget-actions/dk_w/prune'].post;
    expect(op.requestBody).toBeUndefined();
    expect(op['x-bosun-runs-as']).toBe('shell');
  });

  it('never exposes the commands themselves', () => {
    expect(JSON.stringify(doc)).not.toMatch(/docker (ps|restart)|echo ok/);
  });

  it('records the data permission', () => {
    expect(doc.paths['/api/servers/{serverId}/widget-data/dk_w'].get['x-bosun-permission']).toBe('dk.view');
  });
});

import { reviewPackage } from './review';
import { validateManifest } from '@/lib/widgets/package-manifest';

describe('reviewPackage', () => {
  it('lists every command, its account and whether it needs the service account', () => {
    const perm = (id: string) => ({ id, label: id, description: 'd', group: 'Dk', defaultLevel: 'admin', risk: 'high', scope: 'server' });
    const m = validateManifest({
      schema: 1, id: 'dk', name: 'Dk', version: '0.0.1', permissions: [perm('dk.view'), perm('dk.control')],
      widgets: [{ type: 'dk_w', display_name: 'Docker', spec: {
        version: 1, data: { source: 'command', as: 'shell', parse: 'lines', command: 'uptime', permission: 'dk.view' },
        view: { type: 'list', row: { title: '{line}', actions: ['restart'] } },
        actions: [{ id: 'restart', label: 'Restart', permission: 'dk.control', as: 'service', command: 'docker restart {{n}}', confirm: { title: 'Sure?' }, params: { n: { type: 'string', values: ['a'] } } }],
      } }],
    });
    if (!m.ok) throw new Error(m.error);
    const r = reviewPackage(m.value);
    expect(r.commandCount).toBe(2);
    expect(r.runsAsService).toBe(true);
    expect(r.widgets[0].commands.map(c => [c.as, c.command, c.confirm])).toEqual([['shell', 'uptime', false], ['service', 'docker restart {{n}}', true]]);
    expect(r.permissions.map(p => p.id)).toEqual(['dk.view', 'dk.control']);
  });
});

describe('system widget actions in the OpenAPI document', () => {
  const doc = buildOpenApi([]) as any;
  it('lists the built-in widgets actions with their permissions', () => {
    expect(Object.keys(doc.paths).some(p => p.includes('/containers'))).toBe(false);   // a widget's own operations come from its package
    expect(doc.paths['/api/servers/{serverId}/power'].post.requestBody.content['application/json'].schema.required).toEqual(['action', 'confirm']);
  });
});

describe('terminal actions in the OpenAPI document', () => {
  it('are listed as a token-returning operation with the action permission', () => {
    const r = validateWidgetSpec({
      version: 1,
      data: { source: 'snapshot', section: 'services', permission: 'dk.view' },
      view: { type: 'list', row: { title: '{name}', actions: ['shell'] } },
      actions: [{ id: 'shell', label: 'Shell', permission: 'dk.shell', terminal: { ref: 'name', refPattern: '^[a-z]+$', command: 'docker exec -it {{ref}} sh' } }],
    }, ['dk.view', 'dk.shell']);
    if (!r.ok) throw new Error(r.error);
    const doc = buildOpenApi([{ type: 'dk_w', packageId: 'dk', displayName: 'Docker', spec: r.value, permissionLabels: { 'dk.shell': 'Open a shell' } }]) as any;
    const op = doc.paths['/api/servers/{serverId}/widget-actions/dk_w/shell'].post;
    expect(op['x-bosun-permission']).toBe('dk.shell');
    expect(op['x-bosun-runs-as']).toBe('terminal');
    expect(op.requestBody.content['application/json'].schema.required).toEqual(['ref']);
    expect(op.requestBody.content['application/json'].schema.properties.ref.pattern).toBe('^[a-z]+$');
    expect(op.description).toMatch(/Open a shell/);
    expect(op.description).toMatch(/ws\/api-terminal/);
  });
});
