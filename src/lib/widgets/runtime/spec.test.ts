import { describe, it, expect } from 'vitest';
import { validateWidgetSpec, evalCond, fillTemplate, publicSpec, placeholders, type WidgetSpec } from './spec';
import { quoteSh, quotePs, validateParams, renderCommand, commandFor, ParamError } from './command';
import { parseOutput, shapeData, applyMap } from './data';
import { validateManifest } from '@/lib/widgets/package-manifest';

const PERMS = ['dk.control', 'dk.logs'];

/** A spec shaped like the Docker widget: command data, list view, actions with params. */
const dockerLike = (): any => ({
  version: 1,
  data: {
    source: 'command', as: 'service', parse: 'jsonlines', cacheSec: 10,
    command: "docker ps -a --format '{{json .}}'",
    map: { name: 'Names', image: 'Image', state: 'State', status: 'Status' },
  },
  view: {
    type: 'list', empty: 'No containers',
    summary: [{ label: 'running', where: { field: 'state', equals: 'running' } }, { label: 'total' }],
    filter: { fields: ['name', 'image'], placeholder: 'Filter' },
    toggles: [{ key: 'stopped', label: 'stopped', default: true, hideWhen: { field: 'state', notEquals: 'running' } }],
    row: { dot: { field: 'state', colors: { running: 'green', exited: 'gray' } }, title: '{name}', subtitle: '{image} · {status}', actions: ['logs', 'restart'] },
  },
  actions: [
    { id: 'logs', label: 'Logs', icon: 'scroll-text', permission: 'dk.logs', as: 'service', command: 'docker logs --tail {{lines}} {{name}} 2>&1', result: 'text',
      params: { name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$', from: 'name' }, lines: { type: 'number', min: 1, max: 2000 } } },
    { id: 'restart', label: 'Restart', icon: 'rotate-cw', permission: 'dk.control', as: 'service', command: 'docker restart {{name}}', after: 'refresh',
      when: { field: 'state', equals: 'running' }, confirm: { title: 'Restart {name}?', destructive: true },
      params: { name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$', from: 'name' } } },
  ],
});

const ok = (spec: unknown, perms = PERMS) => {
  const r = validateWidgetSpec(spec, perms);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const bad = (mut: (s: any) => void, perms = PERMS) => { const s = dockerLike(); mut(s); return validateWidgetSpec(s, perms); };

describe('validateWidgetSpec', () => {
  it('accepts a Docker-style spec and fills defaults', () => {
    const s = ok(dockerLike());
    expect(s.data.source).toBe('command');
    expect(s.actions[0].timeoutSec).toBe(30);
    expect(s.actions[1].result).toBe('toast');
    expect(s.actions[0].params.lines).toMatchObject({ type: 'number', integer: true });
  });

  it('rejects view actions that are not declared', () => {
    expect(bad(s => { s.view.row.actions = ['logs', 'nuke']; }).ok).toBe(false);
  });

  it('requires every action to name a permission the package declares', () => {
    expect(bad(s => { s.actions[0].permission = 'commands.run'; }).ok).toBe(false);
    expect(bad(s => { delete s.actions[0].permission; }).ok).toBe(false);
    expect(bad(s => { s.data.permission = 'nope.x'; }).ok).toBe(false);
  });

  it('forces an explicit account for every command', () => {
    expect(bad(s => { delete s.actions[0].as; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].as = 'root'; }).ok).toBe(false);
    expect(bad(s => { delete s.data.as; }).ok).toBe(false);
  });

  it('only allows declared, unquoted placeholders in action commands', () => {
    expect(bad(s => { s.actions[1].command = 'docker restart {{other}}'; }).ok).toBe(false);
    expect(bad(s => { s.actions[1].command = "docker restart '{{name}}'"; }).ok).toBe(false);
    expect(bad(s => { s.actions[1].command = 'docker restart "{{name}}"'; }).ok).toBe(false);
    expect(bad(s => { s.actions[1].windowsCommand = 'Restart-Thing {{missing}}'; }).ok).toBe(false);
    // Go-template braces in a data command are not placeholders.
    expect(placeholders("docker ps --format '{{json .}}' {{name}}")).toEqual(['name']);
  });

  it('requires strict parameter declarations', () => {
    expect(bad(s => { s.actions[1].params.name = { type: 'string' }; }).ok).toBe(false);                       // no pattern or values
    expect(bad(s => { s.actions[1].params.name = { type: 'string', pattern: '[a-z]+' }; }).ok).toBe(false);    // not anchored
    expect(bad(s => { s.actions[1].params.name = { type: 'string', pattern: '^(a+' + '$' }; }).ok).toBe(false); // invalid regex
    expect(bad(s => { s.actions[1].params.name = { type: 'string', values: ['a', 'b'] }; }).ok).toBe(true);
    expect(bad(s => { s.actions[0].params.lines = { type: 'number' }; }).ok).toBe(false);                      // no bounds
    expect(bad(s => { s.actions[0].params.lines = { type: 'object' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[1].params.Bad = { type: 'boolean' }; }).ok).toBe(false);
  });

  it('checks data sources, fields and limits', () => {
    expect(bad(s => { s.data = { source: 'snapshot', section: 'docker', path: 'containers' }; }).ok).toBe(true);
    expect(bad(s => { s.data = { source: 'snapshot', section: 'secrets' }; }).ok).toBe(false);
    expect(bad(s => { s.data = { source: 'file', path: '/etc/shadow' }; }).ok).toBe(false);
    expect(bad(s => { s.data.parse = 'xml'; }).ok).toBe(false);
    expect(bad(s => { s.data.cacheSec = 1; }).ok).toBe(false);
    expect(bad(s => { s.data.path = 'a b'; }).ok).toBe(false);
    expect(bad(s => { s.data.map = { x: 'a; b' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].timeoutSec = 9999; }).ok).toBe(false);
    expect(bad(s => { s.actions.push(s.actions[0]); }).ok).toBe(false);
    expect(bad(s => { s.version = 2; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].icon = 'skull'; }).ok).toBe(false);
    expect(bad(s => { s.view.type = 'iframe'; }).ok).toBe(false);
    expect(bad(s => { s.view.toggles[0].hideWhen = { field: 'state' }; }).ok).toBe(false);
    expect(bad(s => { s.view.toggles[0].hideWhen = { field: 'state', equals: 'a', in: ['b'] }; }).ok).toBe(false);
  });

  it('supports table and text views', () => {
    const t = bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}' }, { title: 'Mem', value: '{mem}', format: 'bytes' }], rowActions: ['restart'] }; });
    expect(t.ok).toBe(true);
    expect(bad(s => { s.view = { type: 'table', columns: [] }; }).ok).toBe(false);
    expect(bad(s => { s.view = { type: 'text', text: '{text}' }; }).ok).toBe(true);
    expect(bad(s => { s.view = { type: 'text' }; }).ok).toBe(false);
  });

  it('is validated as part of a package manifest, against the package permissions', () => {
    const perm = (id: string) => ({ id, label: id, description: 'd', group: 'Dk', defaultLevel: 'admin', risk: 'high', scope: 'server' });
    const manifest = (spec: any) => ({ schema: 1, id: 'dk', name: 'Dk', version: '0.0.1', permissions: [perm('dk.control'), perm('dk.logs')], widgets: [{ type: 'dk_w', display_name: 'Dk', spec }] });
    expect(validateManifest(manifest(dockerLike())).ok).toBe(true);
    const wrong = dockerLike(); wrong.actions[0].permission = 'power.restart';
    expect(validateManifest(manifest(wrong)).ok).toBe(false);
    const r = validateManifest(manifest(dockerLike()));
    if (r.ok) expect((r.value.widgets[0].spec as WidgetSpec).actions).toHaveLength(2);
  });
});

describe('conditions and templates', () => {
  it('evaluates conditions', () => {
    const row = { state: 'running', n: 3, nested: { a: 'x' }, empty: '' };
    expect(evalCond({ field: 'state', equals: 'running' }, row)).toBe(true);
    expect(evalCond({ field: 'state', notEquals: 'running' }, row)).toBe(false);
    expect(evalCond({ field: 'n', equals: '3' }, row)).toBe(true);
    expect(evalCond({ field: 'state', in: ['a', 'running'] }, row)).toBe(true);
    expect(evalCond({ field: 'nested.a', equals: 'x' }, row)).toBe(true);
    expect(evalCond({ field: 'missing', exists: false }, row)).toBe(true);
    expect(evalCond({ field: 'empty', exists: true }, row)).toBe(false);
    expect(evalCond({ field: 'missing', notEquals: 'x' }, row)).toBe(true);
  });
  it('fills row templates, treating missing fields as empty and never evaluating anything', () => {
    expect(fillTemplate('{name} · {nested.a}{nope}', { name: 'web', nested: { a: 1 } })).toBe('web · 1');
    expect(fillTemplate('{__proto__}{constructor}', {})).toBe('');
    // `{process.env.X}` is just a (missing) field reference; nothing is evaluated.
    expect(fillTemplate('${process.env.X} {a.b}', { a: { b: 'ok' } })).toBe('$ ok');
  });
  it('publicSpec hides commands, accounts and timeouts', () => {
    const pub = publicSpec(ok(dockerLike()));
    expect(JSON.stringify(pub)).not.toMatch(/docker (restart|logs|ps)|"as":|"command":|"windowsCommand"|timeoutSec/);
    expect(pub.actions.map(a => a.id)).toEqual(['logs', 'restart']);
    expect(pub.actions[1].permission).toBe('dk.control');
  });
});

describe('command rendering', () => {
  const action = ok(dockerLike()).actions[1];
  it('quotes values as a single word', () => {
    expect(quoteSh("a'b")).toBe(`'a'\\''b'`);
    expect(quotePs("a'b")).toBe("'a''b'");
    const v = validateParams(action, { name: 'web-1' });
    expect(renderCommand(action.command, v, 'linux')).toBe("docker restart 'web-1'");
  });
  it('rejects values that do not match the declared pattern, so injection never reaches quoting', () => {
    for (const evil of ['web; reboot', '$(id)', '`id`', 'a b', '-rf', '', '../x', 'a\nb', "a'b", 'x'.repeat(200)]) {
      expect(() => validateParams(action, { name: evil }), evil).toThrow(ParamError);
    }
  });
  it('still quotes safely when a loose pattern lets awkward characters through', () => {
    const loose = { params: { v: { type: 'string', pattern: '^.+$', maxLength: 50 } } } as any;
    const v = validateParams(loose, { v: "x'; reboot; echo '" });
    const cmd = renderCommand('echo {{v}}', v, 'linux');
    expect(cmd).toBe(`echo 'x'\\''; reboot; echo '\\'''`);
    expect(renderCommand('Write-Output {{v}}', v, 'windows')).toBe("Write-Output 'x''; reboot; echo '''");
    expect(() => validateParams(loose, { v: 'a\nb' })).toThrow(/control/);
  });
  it('validates numbers, booleans, unknown and missing params', () => {
    const logs = ok(dockerLike()).actions[0];
    expect(validateParams(logs, { name: 'a', lines: 50 }).lines).toBe('50');
    expect(validateParams(logs, { name: 'a', lines: '50' }).lines).toBe('50');
    expect(() => validateParams(logs, { name: 'a', lines: 0 })).toThrow(ParamError);
    expect(() => validateParams(logs, { name: 'a', lines: 1.5 })).toThrow(ParamError);
    expect(() => validateParams(logs, { name: 'a', lines: '1; id' })).toThrow(ParamError);
    expect(() => validateParams(logs, { name: 'a' })).toThrow(/Missing/);
    expect(() => validateParams(logs, { name: 'a', lines: 5, extra: 1 })).toThrow(/Unknown/);
    expect(() => validateParams(logs, [1])).toThrow(ParamError);
    const flag = { params: { f: { type: 'boolean' } } } as any;
    expect(validateParams(flag, { f: true }).f).toBe('true');
    expect(() => validateParams(flag, { f: 'yes' })).toThrow(ParamError);
    const en = { params: { m: { type: 'string', values: ['start', 'stop'], maxLength: 10 } } } as any;
    expect(validateParams(en, { m: 'start' }).m).toBe('start');
    expect(() => validateParams(en, { m: 'reboot' })).toThrow(ParamError);
  });
  it('has no Windows command unless the action gives one', () => {
    expect(commandFor(action, 'linux')).toBe('docker restart {{name}}');
    expect(commandFor(action, 'windows')).toBeNull();
    expect(commandFor({ command: 'a', windowsCommand: 'b' }, 'windows')).toBe('b');
  });
});

describe('data shaping', () => {
  it('parses each output format', () => {
    expect(parseOutput('jsonlines', '{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseOutput('json', '{"x":[1]}')).toEqual({ x: [1] });
    expect(parseOutput('lines', 'a\n\nb\n')).toEqual([{ line: 'a' }, { line: 'b' }]);
    expect(parseOutput('text', '\u001b[31mhi\u001b[0m')).toEqual({ text: 'hi' });
    expect(() => parseOutput('json', 'nope')).toThrow(/valid JSON/);
    expect(() => parseOutput('jsonlines', '{"a":1}\nnope')).toThrow(/valid JSON/);
  });
  it('selects paths and maps fields', () => {
    const rows = parseOutput('jsonlines', '{"Names":"web","State":"running"}');
    expect(shapeData({ map: { name: 'Names', state: 'State' } }, rows)).toEqual([{ Names: 'web', State: 'running', name: 'web', state: 'running' }]);
    expect(shapeData({ path: 'containers' }, { containers: [{ a: 1 }], other: 2 })).toEqual([{ a: 1 }]);
    expect(shapeData({ path: 'nothing' }, {})).toBeUndefined();
    expect(applyMap({ a: { b: 1 } }, { x: 'a.b' })).toEqual({ a: { b: 1 }, x: 1 });
    expect(shapeData({}, Array.from({ length: 3000 }, (_, i) => ({ i }))) as unknown[]).toHaveLength(2000);
  });
});

describe('parameter defaults', () => {
  it('are kept for the widget form and must satisfy the parameter rules', () => {
    const withDefault = (p: any) => bad(s => { s.actions[0].params.lines = p; });
    const r = validateWidgetSpec((() => { const s = dockerLike(); s.actions[0].params.lines = { type: 'number', min: 1, max: 2000, default: 300 }; return s; })(), PERMS);
    expect(r.ok && r.value.actions[0].params.lines).toMatchObject({ default: 300 });
    expect(withDefault({ type: 'number', min: 1, max: 10, default: 99 }).ok).toBe(false);
    expect(withDefault({ type: 'number', min: 1, max: 10, default: '5' }).ok).toBe(false);
    expect(bad(s => { s.actions[1].params.name = { type: 'string', pattern: '^[a-z]+$', default: 'NOPE' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[1].params.name = { type: 'string', values: ['a', 'b'], default: 'b' }; }).ok).toBe(true);
    expect(bad(s => { s.actions[1].params.name = { type: 'boolean', default: 'yes' }; }).ok).toBe(false);
  });
});
