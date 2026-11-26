import { describe, it, expect } from 'vitest';
import { validateWidgetSpec, evalCond, fillTemplate, publicSpec, placeholders, applyConfigFilters, type WidgetSpec } from './spec';
import { quoteSh, quotePs, validateParams, renderCommand, commandFor, ParamError } from './command';
import { parseOutput, shapeData, applyMap } from './data';
import { validateManifest } from '@/lib/widgets/package-manifest';

const PERMS = ['dk.control', 'dk.logs', 'dk.view'];

/** A spec shaped like the Docker widget: command data, list view, actions with params. */
const dockerLike = (): any => ({
  version: 1,
  data: {
    source: 'command', as: 'service', parse: 'jsonlines', cacheSec: 10, permission: 'dk.view',
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

  it('refuses placeholders inside quoted regions or in text that is run again as code', () => {
    const cmd = (c: string) => bad(s => { s.actions[1].command = c; }).ok;
    const win = (c: string) => bad(s => { s.actions[1].windowsCommand = c; }).ok;
    // Inside quotes, even when not right next to the quote.
    expect(cmd("sh -c 'echo {{name}}'")).toBe(false);
    expect(cmd('echo "id: {{name}}"')).toBe(false);
    expect(cmd("echo 'a {{name}} b'")).toBe(false);
    expect(cmd('echo "$(docker inspect {{name}})"')).toBe(false);
    // Escaped or glued to $ / a backslash.
    expect(cmd('echo \\{{name}}')).toBe(false);
    expect(cmd('echo ${{name}}')).toBe(false);
    // The argument of -c / -Command / -EncodedCommand, or anything after a shell given a command string, eval or ssh.
    expect(cmd('sh -c {{name}}')).toBe(false);
    expect(cmd('bash -lc {{name}}')).toBe(false);
    expect(cmd('/bin/sh -c "docker restart" {{name}}')).toBe(false);
    expect(cmd('su root -c {{name}}')).toBe(false);
    expect(cmd('eval docker restart {{name}}')).toBe(false);
    expect(cmd('ssh other-host docker restart {{name}}')).toBe(false);
    expect(win('powershell -Command {{name}}')).toBe(false);
    expect(win('pwsh.exe -NoProfile -command Restart-Service {{name}}')).toBe(false);
    expect(win('powershell -EncodedCommand {{name}}')).toBe(false);
    expect(win("Write-Output 'x {{name}}'")).toBe(false);
    expect(win('Write-Output ‘x {{name}}’')).toBe(false);
    expect(win('Invoke-Expression {{name}}')).toBe(false);
    // Fine: a bare word, a word with text glued on, quoted text elsewhere, a shell given a script after the value.
    expect(cmd('docker restart {{name}}')).toBe(true);
    expect(cmd("docker logs --since=10m {{name}} 2>&1 | grep -v 'x y'")).toBe(true);
    expect(cmd('docker restart --name={{name}}')).toBe(true);
    expect(cmd("docker exec {{name}} sh -c 'echo hi'")).toBe(true);
    expect(cmd("echo 'it''s' {{name}}")).toBe(true);
    expect(win('Restart-Service -Name {{name}}')).toBe(true);
  });

  it('checks where the {{ref}} of a terminal command is used', () => {
    const t = (terminal: any) => bad(s => { s.actions[1] = { id: 'restart', label: 'Shell', permission: 'dk.control', terminal: { ref: 'name', refPattern: '^[a-z]+$', ...terminal } }; s.view.row.actions = ['logs']; });
    expect(t({ command: "docker exec -it {{ref}} sh -c 'exec bash'" }).ok).toBe(true);
    expect(t({ command: "docker exec -it x sh -c 'cd /{{ref}}; exec bash'" }).ok).toBe(false);
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
    expect(bad(s => { s.data = { source: 'snapshot', section: 'services', path: 'containers', permission: 'dk.view' }; }).ok).toBe(true);
    expect(bad(s => { s.data = { source: 'snapshot', section: 'services', path: 'containers' }; }).ok).toBe(false);   // data.permission is required
    expect(bad(s => { s.data = { source: 'snapshot', section: 'secrets', permission: 'dk.view' }; }).ok).toBe(false);
    expect(bad(s => { s.data = { source: 'file', path: '/etc/shadow', permission: 'dk.view' }; }).ok).toBe(false);
    expect(bad(s => { s.data.parse = 'xml'; }).ok).toBe(false);
    expect(bad(s => { s.data.cacheSec = 1; }).ok).toBe(false);
    expect(bad(s => { s.data.path = 'a b'; }).ok).toBe(false);
    expect(bad(s => { s.data.map = { x: 'a; b' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].timeoutSec = 9999; }).ok).toBe(false);
    expect(bad(s => { s.actions.push(s.actions[0]); }).ok).toBe(false);
    expect(bad(s => { s.version = 3; }).ok).toBe(false);
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

  it('sorts a table by raw column fields and opens a screen from a row', () => {
    const good = bad(s => {
      s.view = {
        type: 'table',
        columns: [{ title: 'Name', value: '{name}', sort: 'name' }, { title: 'Size', value: '{size}', sort: 'size_bytes' }],
        defaultSort: { column: 'Size', dir: 'desc' },
        open: 'image_detail',
      };
    });
    if (!good.ok) throw new Error(good.error);
    expect(good.value.view.columns?.[1].sort).toBe('size_bytes');
    expect(good.value.view.defaultSort).toEqual({ column: 'Size', dir: 'desc' });
    expect(good.value.view.open).toBe('image_detail');
    // A list may open a row's details too.
    expect(bad(s => { s.view = { type: 'list', row: { title: '{name}', actions: [] }, open: 'detail' }; }).ok).toBe(true);

    expect(bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}', sort: 'a b' }] }; }).ok).toBe(false);
    expect(bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}', sort: 'name' }], defaultSort: { column: 'Size', dir: 'desc' } }; }).ok).toBe(false);
    expect(bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}' }], defaultSort: { column: 'Name', dir: 'desc' } }; }).ok).toBe(false);
    expect(bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}', sort: 'name' }], defaultSort: { column: 'Name', dir: 'up' } }; }).ok).toBe(false);
    expect(bad(s => { s.view = { type: 'table', columns: [{ title: 'Name', value: '{name}' }], open: 'Bad Id' }; }).ok).toBe(false);
  });

  it('is validated as part of a package manifest, against the package permissions', () => {
    const perm = (id: string) => ({ id, label: id, description: 'd', group: 'Dk', defaultLevel: 'admin', risk: 'high', scope: 'server' });
    const manifest = (spec: any) => ({ schema: 1, id: 'dk', name: 'Dk', version: '0.0.1', permissions: [perm('dk.control'), perm('dk.logs'), perm('dk.view')], widgets: [{ type: 'dk_w', display_name: 'Dk', spec }] });
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
    // PowerShell treats the typographic single quotes as quotes too: each must be doubled, or it would end the string.
    expect(quotePs('a\u2018b\u2019c\u201Ad\u201Be')).toBe("'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'");
    expect(quotePs('x\u2019; Remove-Item C:\\ -Recurse; \u2019')).toBe("'x\u2019\u2019; Remove-Item C:\\ -Recurse; \u2019\u2019'");
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

describe('terminal actions', () => {
  const withShell = (extra: Record<string, unknown> = {}) => {
    const s = dockerLike();
    s.actions.push({ id: 'shell', label: 'Shell', icon: 'terminal-square', permission: 'dk.logs', terminal: { ref: 'name', refPattern: '^[a-z][a-z0-9_.-]{0,60}$', command: "docker exec -it {{ref}} sh" }, ...extra });
    s.view.row.actions = ['logs', 'shell'];
    return validateWidgetSpec(s, PERMS);
  };

  it('is accepted, runs nothing, and needs a package permission', () => {
    const r = withShell({ when: { field: 'state', equals: 'running' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a = r.value.actions.find(x => x.id === 'shell')!;
      expect(a).toMatchObject({ kind: 'terminal', terminal: { ref: 'name', command: 'docker exec -it {{ref}} sh' }, command: '', params: {} });
      expect(r.value.actions.find(x => x.id === 'logs')?.kind).toBe('command');
    }
    expect(withShell({ permission: 'power.restart' }).ok).toBe(false);
  });

  it('cannot also carry a command or parameters, and needs a valid target field, pattern and command', () => {
    expect(withShell({ command: 'docker exec -it {{name}} sh', params: { name: { type: 'string', values: ['a'] } } }).ok).toBe(false);
    expect(withShell({ windowsCommand: 'x' }).ok).toBe(false);
    expect(withShell({ terminal: {} }).ok).toBe(false);
    const t = (over: Record<string, unknown>) => ({ ref: 'name', refPattern: '^[a-z]+$', command: 'docker exec -it {{ref}} sh', ...over });
    expect(withShell({ terminal: t({ ref: 'a b; id' }) }).ok).toBe(false);
    expect(withShell({ terminal: t({ refPattern: '[a-z]+' }) }).ok).toBe(false);          // not anchored
    expect(withShell({ terminal: t({ refPattern: '^(a$' }) }).ok).toBe(false);            // not a regular expression
    expect(withShell({ terminal: t({ command: 'docker exec -it name sh' }) }).ok).toBe(false);   // no {{ref}}
    expect(withShell({ terminal: t({ command: 'echo {{ref}} {{ref}}' }) }).ok).toBe(false);      // twice
    expect(withShell({ terminal: t({ command: 'echo {{ref}} {{other}}' }) }).ok).toBe(false);    // another placeholder
    expect(withShell({ terminal: t({ command: 'echo {{ref}}\nid' }) }).ok).toBe(false);          // two lines
    expect(withShell({ terminal: t({ command: 'x'.repeat(501) + '{{ref}}' }) }).ok).toBe(false);
    expect(withShell({ terminal: t({ check: 'probe' }) }).ok).toBe(false);                // a check needs version 2
  });

  it('survives being stored and validated again (the normalised form)', () => {
    const first = withShell();
    if (!first.ok) throw new Error(first.error);
    const again = validateWidgetSpec(JSON.parse(JSON.stringify(first.value)), PERMS);
    expect(again.ok).toBe(true);
  });

  it('is described to the browser without a command, and is not offered as an API operation', () => {
    const r = withShell();
    if (!r.ok) throw new Error(r.error);
    const pub = publicSpec(r.value);
    expect(pub.actions.find(a => a.id === 'shell')).toMatchObject({ kind: 'terminal', terminal: { ref: 'name' } });
    expect(JSON.stringify(pub)).not.toMatch(/"command":|"as":|docker exec|refPattern/);
  });
});

describe('data.filter and data.unavailable', () => {
  const snap = (extra: object) => ({
    version: 1, view: { type: 'list', row: { title: '{name}', actions: [] } },
    data: { source: 'snapshot', section: 'services', permission: 'dk.view', ...extra },
  });

  it('validates the settings filter and the unavailable notice', () => {
    const ok = validateWidgetSpec(snap({
      filter: [{ field: 'status', config: 'filter', all: 'all', default: 'running' }],
      unavailable: { when: { field: 'available', equals: false }, message: 'Not available: {error}' },
    }), PERMS);
    expect(ok.ok).toBe(true);
    expect(validateWidgetSpec(snap({ filter: [{ field: 'status', config: 'Bad Name' }] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(snap({ filter: [] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(snap({ unavailable: { when: { field: 'x', equals: 1 } } }), PERMS).ok).toBe(false);
  });

  it('keeps the rows that match the widget setting', () => {
    const rows = [{ name: 'a', status: 'running' }, { name: 'b', status: 'stopped' }, { name: 'c', status: 'failed' }];
    const f = [{ field: 'status', config: 'filter', all: 'all', default: 'running' }];
    expect(applyConfigFilters(rows, f, {})).toEqual([rows[0]]);                           // default
    expect(applyConfigFilters(rows, f, { filter: 'failed' })).toEqual([rows[2]]);
    expect(applyConfigFilters(rows, f, { filter: 'all' })).toEqual(rows);
    expect(applyConfigFilters({ not: 'rows' }, f, {})).toEqual({ not: 'rows' });
    expect(applyConfigFilters(rows, undefined, {})).toBe(rows);
  });
});

describe('fields views', () => {
  const spec = (view: object) => ({ version: 1, data: { source: 'snapshot', section: 'cpu_memory', permission: 'dk.view' }, view });

  it('accepts labelled values with gauges, formats and conditions', () => {
    const r = validateWidgetSpec(spec({
      type: 'fields',
      fields: [
        { label: 'CPU', value: '{cpu.usage}', format: 'percent', bar: '{cpu.usage}' },
        { label: 'Uptime', value: '{uptime}', format: 'duration', when: { field: 'uptime', exists: true } },
      ],
    }), PERMS);
    expect(r.ok).toBe(true);
  });

  it('also allows fields on list rows and a bar column in tables', () => {
    const list = spec({ type: 'list', row: { title: '{name}', fields: [{ label: 'Util', value: '{util}', format: 'bar', bar: '{util}' }], actions: [] } });
    expect(validateWidgetSpec(list, PERMS).ok).toBe(true);
    const table = spec({ type: 'table', columns: [{ title: 'Used', value: '{pct}', format: 'bar' }] });
    expect(validateWidgetSpec(table, PERMS).ok).toBe(true);
  });

  it('rejects empty or malformed fields', () => {
    expect(validateWidgetSpec(spec({ type: 'fields', fields: [] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(spec({ type: 'fields', fields: [{ label: 'x' }] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(spec({ type: 'fields', fields: [{ label: 'x', value: '{a}', format: 'nope' }] }), PERMS).ok).toBe(false);
  });
});

describe('metrics a widget tracks', () => {
  const withMetrics = (metrics: unknown) => ({
    version: 1, view: { type: 'text', text: '{x}' }, metrics,
    data: { source: 'snapshot', section: 'cpu_memory', permission: 'dk.view' },
  });

  it('accepts built-in metric names with retention and computed ones with from', () => {
    const r = validateWidgetSpec(withMetrics([
      { name: 'cpu.usage', unit: '%', rawHours: 72, rollup5mDays: 60, rollup1hDays: 730 },
      { name: 'gpu*.util' },
      { name: 'dk.running', label: 'Running', from: { agg: 'count', where: { field: 'state', equals: 'running' } } },
      { name: 'dk.mem', from: { agg: 'sum', field: 'mem_mb' } },
    ]), PERMS, 'dk');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.metrics?.[0]).toMatchObject({ name: 'cpu.usage', rawHours: 72 });
  });

  it('rejects bad names, retention, duplicates and unprefixed computed metrics', () => {
    const bad = (m: unknown) => validateWidgetSpec(withMetrics(m), PERMS, 'dk').ok;
    expect(bad([])).toBe(false);
    expect(bad([{ name: 'Bad Name' }])).toBe(false);
    expect(bad([{ name: 'cpu.usage', rawHours: 0 }])).toBe(false);
    expect(bad([{ name: 'cpu.usage', rollup1hDays: 99999 }])).toBe(false);
    expect(bad([{ name: 'cpu.usage' }, { name: 'cpu.usage' }])).toBe(false);
    expect(bad([{ name: 'other.running', from: { agg: 'count' } }])).toBe(false);        // must start with the package id
    expect(bad([{ name: 'dk.x', from: { agg: 'sum' } }])).toBe(false);                   // sum needs a field
    expect(bad([{ name: 'dk.*', from: { agg: 'count' } }])).toBe(false);
  });
});

describe('chart views', () => {
  const chart = (c: unknown) => ({ version: 1, data: { source: 'snapshot', section: 'metrics', permission: 'dk.view' }, view: { type: 'chart', chart: c } });
  it('needs 1-6 metric names', () => {
    expect(validateWidgetSpec(chart({ metrics: ['cpu.usage', 'mem.used_pct'] }), PERMS).ok).toBe(true);
    expect(validateWidgetSpec(chart({ metrics: [] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(chart({ metrics: ['Bad Name'] }), PERMS).ok).toBe(false);
    expect(validateWidgetSpec(chart(undefined), PERMS).ok).toBe(false);
  });
});

describe('the stacks declaration (import from other tools)', () => {
  it('must point at the widget\'s own runnable actions, datasets and row fields', async () => {
    const fs = await import('fs');
    const m = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
    const own = m.permissions.map((p: { id: string }) => p.id);
    const spec = m.widgets[0].spec;
    const ok = validateWidgetSpec(spec, own, m.id);
    expect(ok.ok && ok.value.stacks?.deploy).toBeTruthy();
    for (const [k, v] of [['deploy', 'nope'], ['guard', 'stack_edit'], ['list', 'nope'], ['export', 'nope']] as const) {
      const bad = validateWidgetSpec({ ...spec, stacks: { ...spec.stacks, [k]: v } }, own, m.id);
      expect(bad.ok, k).toBe(false);
    }
    expect(validateWidgetSpec({ ...spec, stacks: { ...spec.stacks, fields: { id: 'ID' } } }, own, m.id).ok).toBe(false);
  });

  it('setup names a detect dataset and an install action without required parameters', async () => {
    const fs = await import('fs');
    const m = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
    const own = m.permissions.map((p: { id: string }) => p.id);
    const spec = m.widgets[0].spec;
    const ok = validateWidgetSpec(spec, own, m.id);
    expect(ok.ok && ok.value.setup).toMatchObject({ label: 'Docker Engine', detect: 'host_detect', install: 'docker_install' });
    for (const bad of [{ ...spec.setup, detect: 'nope' }, { ...spec.setup, install: 'nope' }, { ...spec.setup, install: 'stack_deploy' }, { ...spec.setup, label: '' }, 'x']) {
      expect(validateWidgetSpec({ ...spec, setup: bad }, own, m.id).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('deployLater and deployPrivilegedLater name runnable actions; without them nothing changes', async () => {
    const fs = await import('fs');
    const m = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
    const own = m.permissions.map((p: { id: string }) => p.id);
    const spec = m.widgets[0].spec;
    const ok = validateWidgetSpec(spec, own, m.id);
    expect(ok.ok && ok.value.stacks).toMatchObject({ deployLater: 'stack_deploy_later', deployPrivilegedLater: 'stack_deploy_privileged_later' });
    for (const v of ['nope', 3]) {
      expect(validateWidgetSpec({ ...spec, stacks: { ...spec.stacks, deployLater: v } }, own, m.id).ok, String(v)).toBe(false);
    }
    // a widget without them: own stacks are imported from another node, as before
    const { deployLater: _a, deployPrivilegedLater: _b, ...without } = spec.stacks;
    const old = validateWidgetSpec({ ...spec, stacks: without }, own, m.id);
    expect(old.ok && old.value.stacks?.deployLater).toBeUndefined();
  });

  it('every caller of the deploy script gets start from the action itself (Bosun does not fill in defaults)', async () => {
    const fs = await import('fs');
    const m = JSON.parse(fs.readFileSync('widgets/docker/manifest.json', 'utf8'));
    const users = m.widgets[0].spec.actions.filter((a: { variants?: { script: string }[] }) => a.variants?.some(v => v.script === 'stack_deploy'));
    expect(users.map((a: { id: string }) => a.id).sort()).toEqual(['stack_deploy', 'stack_deploy_later', 'stack_deploy_privileged', 'stack_deploy_privileged_later']);
    for (const a of users) {
      expect(a.params.start, a.id).toBeUndefined();
      expect(a.variants[0].args.start, a.id).toBe(a.id.endsWith('_later') ? 'literal:later' : 'literal:now');
    }
  });
});