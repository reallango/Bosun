import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateWidgetSpec, publicSpec, evalCond, isNewerVersion } from './spec';
import { cond } from './spec-util';
import { validateManifest, scriptFilesOf, validateScriptFiles, manifestToJson } from '@/lib/widgets/package-manifest';
import { extractMetrics } from './data';

const dir = path.join(process.cwd(), 'widgets');
const draft = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8'));

/** A script file for every script a package names (only the checks of the manifest are under test here, not the scripts). */
const dummyFiles = (m: ReturnType<typeof validateManifest> & { ok: true }) =>
  Object.fromEntries(scriptFilesOf(m.value).map(f => [f, '# placeholder\n']));

describe('the three ported packages (Ollama, OS Update Check, Custom Command)', () => {
  for (const name of ['ollama', 'updates', 'commands']) {
    it(`${name} is a valid version 2 package whose script files can be checked`, () => {
      const m = validateManifest(draft(name));
      if (!m.ok) throw new Error(m.error);
      expect(m.value.widgets[0].spec?.version).toBe(2);
      expect(scriptFilesOf(m.value).length).toBeGreaterThan(0);
      expect(validateScriptFiles(m.value, dummyFiles(m)).ok).toBe(true);
      // It survives being stored and read back.
      expect(validateManifest(manifestToJson(m.value)).ok).toBe(true);
    });
  }

  it('Ollama needs the script files it names, and says which is missing', () => {
    const m = validateManifest(draft('ollama'));
    if (!m.ok) throw new Error(m.error);
    const files = dummyFiles(m);
    delete files['scripts/dk_recreate.sh'];
    expect(validateScriptFiles(m.value, files)).toEqual({ ok: false, error: 'the package does not contain the script file "scripts/dk_recreate.sh"' });
    expect(validateScriptFiles(m.value, { ...dummyFiles(m), 'scripts/status.sh': '   ' }).ok).toBe(false);
  });

  it('Ollama declares what it contacts and what it detects', () => {
    const m = validateManifest(draft('ollama'));
    if (!m.ok) throw new Error(m.error);
    expect(m.value.network).toEqual(['api.github.com']);
    const spec = m.value.widgets[0].spec!;
    expect(spec.state?.script).toBe('detect');
    expect(spec.lookups?.latest.ttlSec).toBe(21600);
    expect(spec.actions.filter(a => a.job).map(a => a.id).sort()).toEqual(['install', 'install_host', 'pull', 'set_context_length', 'set_max_loaded', 'update']);
    expect(spec.view.type).toBe('layout');
  });

  it('Custom Command takes its command and interval from instance settings and guards the command with a permission', () => {
    const m = validateManifest(draft('commands'));
    if (!m.ok) throw new Error(m.error);
    const data = m.value.widgets[0].spec!.data;
    expect(data).toMatchObject({ source: 'command', script: 'run', args: { command: 'config.command' }, cacheSecFrom: 'config.interval' });
    const schema = JSON.parse(String(m.value.widgets[0].columns.config_schema));
    expect(schema.find((f: { key: string }) => f.key === 'command').requires_permission).toBe('commands.run');
  });

  it('OS Update Check collects slowly, stores the result of "check now" and installs as a job', () => {
    const m = validateManifest(draft('updates'));
    if (!m.ok) throw new Error(m.error);
    const spec = m.value.widgets[0].spec!;
    expect(spec.data).toMatchObject({ cacheSec: 21600, initialDelaySec: 60, timeoutSec: 600 });
    expect(spec.actions.find(a => a.id === 'check_now')).toMatchObject({ job: true, stores: 'data' });
    expect(spec.actions.find(a => a.id === 'install')).toMatchObject({ job: true, after: 'refresh' });
  });

  it('a manifest cannot reach a host it did not declare, nor require a permission it does not have', () => {
    const d = draft('ollama');
    d.network = [];
    expect(validateManifest(d)).toMatchObject({ ok: false, error: expect.stringContaining('api.github.com') });
    const c = draft('commands');
    c.widgets[0].config_schema[0].requires_permission = 'commands.nope';
    expect(validateManifest(c)).toMatchObject({ ok: false, error: expect.stringContaining('commands.nope') });
  });

  it('the browser is never sent scripts, the state probe, lookups or script arguments', () => {
    const m = validateManifest(draft('ollama'));
    if (!m.ok) throw new Error(m.error);
    const pub = publicSpec(m.value.widgets[0].spec!) as unknown as Record<string, unknown>;
    expect(pub.scripts).toBeUndefined();
    expect(pub.state).toBeUndefined();
    expect(pub.lookups).toBeUndefined();
    const text = JSON.stringify(pub);
    expect(text).not.toContain('scripts/');
    expect(text).not.toContain('win_control');
    expect(text).not.toContain('literal:');
    // It does get what it needs to choose which actions to show: the conditions of the variants.
    const start = (pub.actions as { id: string; variants: { when?: unknown }[] }[]).find(a => a.id === 'start')!;
    expect(start.variants).toHaveLength(3);
    expect(start.variants[0].when).toBeDefined();
  });
});

const base = (): Record<string, unknown> => ({
  version: 2,
  scripts: { a: { as: 'service', linux: 'scripts/a.sh', params: { name: { type: 'string', pattern: '^[a-z]{1,10}$' } } } },
  data: { source: 'snapshot', section: 'docker', permission: 'dk.view' },
  actions: [],
  view: { type: 'text', text: '{x}' },
});
const check = (mutate: (s: any) => void) => { const s = base() as any; mutate(s); return validateWidgetSpec(s, ['dk.view', 'dk.run'], 'dk'); };

describe('version handling', () => {
  it('accepts versions 1 and 2 only, and keeps version 2 features out of version 1', () => {
    expect(check(() => undefined).ok).toBe(true);
    expect(check(s => { s.version = 3; }).ok).toBe(false);
    expect(check(s => { s.version = 1; }).ok).toBe(false);                        // scripts need version 2
    expect(check(s => { s.version = 1; delete s.scripts; }).ok).toBe(true);
    expect(check(s => { s.version = 1; delete s.scripts; s.view = { type: 'layout', blocks: [{ type: 'text', text: 'x' }] }; }).ok).toBe(false);
  });
});

describe('scripts', () => {
  it('need an account, at least one platform file with the right extension, and strict parameters', () => {
    expect(check(s => { delete s.scripts.a.as; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.as = 'root'; }).ok).toBe(false);
    expect(check(s => { delete s.scripts.a.linux; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.linux = 'scripts/a.ps1'; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.windows = 'scripts/a.sh'; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.linux = '../a.sh'; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.linux = '/etc/a.sh'; }).ok).toBe(false);
    expect(check(s => { s.scripts.a.windows = 'win/a.ps1'; }).ok).toBe(true);
    expect(check(s => { s.scripts.a.params.name = { type: 'string' }; }).ok).toBe(false);   // a string needs a pattern or values
    expect(check(s => { s.scripts.a.timeoutSec = 99999; }).ok).toBe(false);
  });
});

describe('state, lookups', () => {
  it('state names a parameterless script, a sane period and typed fields', () => {
    const withState = (state: unknown) => check(s => { s.scripts.p = { as: 'service', linux: 'scripts/p.sh' }; s.state = state; });
    expect(withState({ script: 'p', periodSec: 60, fields: { 'install.kind': 'string', ready: 'boolean' } }).ok).toBe(true);
    expect(withState({ script: 'nope' }).ok).toBe(false);
    expect(withState({ script: 'a' }).ok).toBe(false);                                        // has a parameter
    expect(withState({ script: 'p', periodSec: 5 }).ok).toBe(false);
    expect(withState({ script: 'p', fields: { 'Bad Name': 'string' } }).ok).toBe(false);
    expect(withState({ script: 'p', fields: { ok: 'object' } }).ok).toBe(false);
  });

  it('lookups are plain https GETs of a host name with a path, one capture group and a sane cache time', () => {
    const lk = (l: object) => check(s => { s.lookups = { latest: { path: 'tag_name', ttlSec: 3600, ...l } }; });
    expect(lk({ url: 'https://api.github.com/repos/a/b/releases/latest', match: '(\\d+\\.\\d+\\.\\d+)' }).ok).toBe(true);
    expect(lk({ url: 'http://api.github.com/x' }).ok).toBe(false);
    expect(lk({ url: 'https://user:pw@api.github.com/x' }).ok).toBe(false);
    expect(lk({ url: 'https://api.github.com:8443/x' }).ok).toBe(false);
    expect(lk({ url: 'https://127.0.0.1/x' }).ok).toBe(false);
    expect(lk({ url: 'https://localhost/x' }).ok).toBe(false);
    expect(lk({ url: 'https://api.github.com/x', match: '\\d+' }).ok).toBe(false);          // no capture group
    expect(lk({ url: 'https://api.github.com/x', match: '(a)(b)' }).ok).toBe(false);        // two
    expect(lk({ url: 'https://api.github.com/x', match: '(' }).ok).toBe(false);             // not a regular expression
    expect(lk({ url: 'https://api.github.com/x', ttlSec: 5 }).ok).toBe(false);
  });
});

describe('script actions', () => {
  const act = (a: object) => check(s => {
    s.actions = [{ id: 'go', label: 'Go', permission: 'dk.run', kind: 'script', params: { name: { type: 'string', pattern: '^[a-z]{1,10}$' } }, variants: [{ script: 'a' }], ...a }];
  });

  it('run a variant of a declared script; every parameter of the script must be supplied', () => {
    expect(act({}).ok).toBe(true);                                                           // "name" comes from the action parameter
    expect(act({ variants: [{ script: 'zzz' }] }).ok).toBe(false);
    expect(act({ variants: [] }).ok).toBe(false);
    expect(act({ params: {} }).ok).toBe(false);                                              // nothing supplies "name"
    expect(act({ params: {}, variants: [{ script: 'a', args: { name: 'state.install.name' } }] }).ok).toBe(true);
    expect(act({ params: {}, variants: [{ script: 'a', args: { name: 'literal:fixed' } }] }).ok).toBe(true);
    expect(act({ variants: [{ script: 'a', args: { other: 'state.x' } }] }).ok).toBe(false);  // not a parameter of the script
    expect(act({ variants: [{ script: 'a', args: { name: 'param.nope' } }] }).ok).toBe(false);
    expect(act({ variants: [{ script: 'a', args: { name: 'x; rm -rf /' } }] }).ok).toBe(false);
  });

  it('cannot carry a command, need their own permission, and take only known flags', () => {
    expect(act({ command: 'ls' }).ok).toBe(false);
    expect(act({ windowsCommand: 'dir' }).ok).toBe(false);
    expect(act({ permission: 'dk.unknown' }).ok).toBe(false);
    expect(act({ job: 'yes' }).ok).toBe(false);
    expect(act({ job: true, stores: 'data' }).ok).toBe(true);
    expect(act({ stores: 'file' }).ok).toBe(false);
    expect(act({ confirm: { title: 'Delete {name}?', requireText: '{name}' } }).ok).toBe(true);
    expect(act({ kind: 'script', when: { all: [{ field: 'state.x', equals: 1 }, { not: { field: 'state.y', exists: true } }] } }).ok).toBe(true);
  });

  it('are refused in version 1', () => {
    expect(check(s => { s.version = 1; delete s.scripts; s.actions = [{ id: 'go', label: 'Go', permission: 'dk.run', kind: 'script', variants: [{ script: 'a' }] }]; }).ok).toBe(false);
  });
});

describe('script data', () => {
  const data = (d: object) => check(s => { s.data = { source: 'command', script: 'a', parse: 'json', permission: 'dk.view', args: { name: 'config.name' }, ...d }; });

  it('gets its parameters from instance settings only', () => {
    expect(data({}).ok).toBe(true);
    expect(data({ args: {} }).ok).toBe(false);                                               // "name" is missing
    expect(data({ args: { name: 'state.x' } }).ok).toBe(false);                              // not an instance setting
    expect(data({ args: { name: 'param.name' } }).ok).toBe(false);
    expect(data({ script: 'nope' }).ok).toBe(false);
  });

  it('may collect rarely and take minutes, and take its interval from a setting', () => {
    expect(data({ cacheSec: 21600, timeoutSec: 600, initialDelaySec: 300 }).ok).toBe(true);
    expect(data({ cacheSec: 999999 }).ok).toBe(false);
    expect(data({ timeoutSec: 901 }).ok).toBe(false);
    expect(data({ cacheSecFrom: 'config.interval' }).ok).toBe(true);
    expect(data({ cacheSecFrom: 'state.interval' }).ok).toBe(false);
  });
});

describe('layout views', () => {
  const layout = (blocks: unknown, actions: object[] = []) => check(s => {
    s.actions = actions;
    s.view = { type: 'layout', blocks };
  });
  const action = { id: 'go', label: 'Go', permission: 'dk.run', kind: 'script', params: { name: { type: 'string', pattern: '^[a-z]{1,10}$' } }, variants: [{ script: 'a' }] };

  it('accept sections with badges, key/value lists, notices, buttons, forms, selects, job progress and embedded views', () => {
    const ok = layout([
      { type: 'section', title: 'Installation', defaultOpen: false, badges: [{ text: 'Update available', color: 'blue', when: { field: 'lookups.latest', newerThan: 'data.version' } }], blocks: [
        { type: 'kv', items: [{ label: 'Kind', value: '{state.install.kind}', format: 'text' }] },
        { type: 'notice', level: 'warning', text: 'Careful', when: { field: 'state.install.kind', equals: 'none' } },
        { type: 'buttons', actions: ['go'] },
        { type: 'select', label: 'Mode', value: 'state.mode', options: [{ value: 'a', label: 'A' }], action: 'go', param: 'name' },
        { type: 'form', fields: [{ name: 'name', label: 'Name', input: 'text' }], submit: { action: 'go', label: 'Apply', params: { name: 'name' } } },
        { type: 'jobProgress' },
      ] },
      { type: 'view', path: 'tags.models', view: { type: 'list', row: { title: '{name}', actions: ['go'] } } },
    ], [action]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.view.blocks?.[0]).toMatchObject({ type: 'section', defaultOpen: false });
  });

  it('refuse unknown block types, actions that do not exist and bad forms', () => {
    expect(layout([{ type: 'iframe', src: 'x' }]).ok).toBe(false);
    expect(layout([{ type: 'buttons', actions: ['ghost'] }], [action]).ok).toBe(false);
    expect(layout([{ type: 'form', fields: [{ name: 'a', label: 'A', input: 'text' }], submit: { action: 'go', label: 'Go', params: { name: 'zzz' } } }], [action]).ok).toBe(false);
    expect(layout([{ type: 'form', fields: [{ name: 'a', label: 'A', input: 'file' }], submit: { action: 'go', label: 'Go' } }], [action]).ok).toBe(false);
    expect(layout([{ type: 'select', label: 'M', value: 'state.m', options: [], action: 'go', param: 'name' }], [action]).ok).toBe(false);
    expect(layout([{ type: 'section', title: 'S', badges: [{ text: 'x', color: 'purple' }], blocks: [{ type: 'text', text: 'x' }] }]).ok).toBe(false);
    expect(layout([]).ok).toBe(false);
  });

  it('are limited in depth and size, and a layout cannot hold another layout', () => {
    const nest = (n: number): unknown => (n === 0 ? [{ type: 'text', text: 'x' }] : [{ type: 'section', title: 's', blocks: nest(n - 1) }]);
    expect(layout(nest(2)).ok).toBe(true);
    expect(layout(nest(5)).ok).toBe(false);
    expect(layout(Array.from({ length: 31 }, () => ({ type: 'text', text: 'x' }))).ok).toBe(false);
    expect(layout([{ type: 'view', view: { type: 'layout', blocks: [{ type: 'text', text: 'x' }] } }]).ok).toBe(false);
  });
});

describe('conditions', () => {
  const ctx = { state: { install: { kind: 'service', manager: 'nssm' }, count: 3 }, data: { version: '0.40.10' }, lookups: { latest: '0.40.13' } };

  it('combine with all, any and not, and compare numbers and versions', () => {
    expect(evalCond({ all: [{ field: 'state.install.kind', equals: 'service' }, { field: 'state.install.manager', in: ['nssm', 'windows'] }] }, ctx)).toBe(true);
    expect(evalCond({ any: [{ field: 'state.install.kind', equals: 'docker' }, { field: 'state.count', gt: 2 }] }, ctx)).toBe(true);
    expect(evalCond({ not: { field: 'state.install.kind', equals: 'service' } }, ctx)).toBe(false);
    expect(evalCond({ field: 'state.count', gte: 3 }, ctx)).toBe(true);
    expect(evalCond({ field: 'state.count', lt: 3 }, ctx)).toBe(false);
    expect(evalCond({ field: 'state.missing', gt: 0 }, ctx)).toBe(false);
    expect(evalCond({ field: 'lookups.latest', newerThan: 'data.version' }, ctx)).toBe(true);
    expect(evalCond({ field: 'data.version', newerThan: 'lookups.latest' }, ctx)).toBe(false);
    expect(evalCond({ field: 'lookups.nothing', newerThan: 'data.version' }, ctx)).toBe(false);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
  });

  it('are validated: exactly one comparison, or exactly one combination', () => {
    expect(cond({ field: 'x', equals: 1, exists: true }, 'c').ok).toBe(false);
    expect(cond({ field: 'x' }, 'c').ok).toBe(false);
    expect(cond({ all: [] }, 'c').ok).toBe(false);
    expect(cond({ all: [{ field: 'x', exists: true }], any: [{ field: 'y', exists: true }] }, 'c').ok).toBe(false);
    expect(cond({ all: [{ field: 'x', exists: true }], field: 'y' }, 'c').ok).toBe(false);
    expect(cond({ field: 'x', gt: 'a' }, 'c').ok).toBe(false);
    expect(cond({ field: 'x', newerThan: 'not a path!' }, 'c').ok).toBe(false);
    let deep: Record<string, unknown> = { field: 'x', exists: true };
    for (let i = 0; i < 6; i++) deep = { not: deep };
    expect(cond(deep, 'c').ok).toBe(false);
  });
});

describe('tracked metrics from a list inside the data', () => {
  it('count the rows at the declared path', () => {
    const metrics = [{ name: 'ollama.loaded', from: { agg: 'count', path: 'ps.models' } }];
    expect(extractMetrics(metrics, { ps: { models: [{ name: 'a' }, { name: 'b' }] } })).toEqual({ 'ollama.loaded': 2 });
    expect(extractMetrics(metrics, { ps: {} })).toEqual({ 'ollama.loaded': 0 });
  });
});
