import { describe, it, expect } from 'vitest';
import { validateWidgetSpec, publicSpec } from './spec';
import { editorInitial, editorMissing, editorOptions, editorSubmitParams, editorWarnings, screenArgs, serializeEditor } from './layout';
import { validateParamValues } from './script-run';

const PERMS = ['pk.view', 'pk.manage'];

const base = (): any => ({
  version: 2,
  scripts: {
    load: { as: 'service', timeoutSec: 30, linux: 'scripts/load.sh', params: { name: { type: 'string', pattern: '^[a-z]+$', maxLength: 40 } } },
    list: { as: 'service', timeoutSec: 30, linux: 'scripts/list.sh' },
    save: { as: 'service', timeoutSec: 60, linux: 'scripts/save.sh', params: { name: { type: 'string', pattern: '^[a-z]+$', maxLength: 40 }, settings: { type: 'text', maxLength: 4000, maxLines: 50, linePattern: '^[a-z_]+=.*$' } } },
  },
  datasets: {
    one: { script: 'load', cacheSec: 5, permission: 'pk.view' },
    all: { script: 'list', cacheSec: 5, permission: 'pk.view' },
  },
  data: { source: 'snapshot', section: 'services', permission: 'pk.view' },
  actions: [
    { id: 'edit', label: 'Edit', icon: 'pencil', permission: 'pk.manage', kind: 'screen', screen: 'edit' },
    { id: 'save', label: 'Save', permission: 'pk.manage', kind: 'script', params: { name: { type: 'string', pattern: '^[a-z]+$', maxLength: 40 }, settings: { type: 'text', maxLength: 4000, maxLines: 50, linePattern: '^[a-z_]+=.*$' } }, variants: [{ script: 'save' }], after: 'refresh' },
  ],
  screens: {
    edit: {
      kind: 'dialog', title: 'Edit {name}', size: 'xl', load: { cur: { dataset: 'one', args: { name: 'context.name' } } },
      blocks: [{
        type: 'editor', param: 'settings',
        fields: [
          { name: 'image', label: 'Image', input: 'text', value: 'datasets.cur.settings.image', required: true },
          { name: 'env', label: 'Environment', input: 'pairs', value: 'datasets.cur.settings.env' },
          { name: 'tty', label: 'TTY', input: 'checkbox', value: 'datasets.cur.settings.tty' },
          { name: 'net', label: 'Network', input: 'select', key: 'network', optionsFrom: { path: 'datasets.nets', value: 'name' } },
          { name: 'priv', label: 'Privileged', input: 'checkbox', key: 'privileged', warn: 'Gives the container the host.' },
        ],
        submits: [{ action: 'save', label: 'Save', params: { name: 'context.name' } }],
      }],
    },
    manage: { kind: 'page', title: 'Manage', blocks: [{ type: 'tabs', tabs: [{ id: 'a', label: 'A', blocks: [{ type: 'text', text: 'hi' }] }] }] },
  },
  menu: [{ id: 'manage', label: 'Manage', icon: 'settings', screen: 'manage', permission: 'pk.manage' }],
  view: { type: 'text', text: 'x' },
});

const bad = (mut: (s: any) => void) => { const s = base(); mut(s); return validateWidgetSpec(s, PERMS, 'pk'); };

describe('the text parameter', () => {
  const declared = { s: { type: 'text', maxLength: 50, maxLines: 3, linePattern: '^[a-z]+=.*$' } };
  it('allows several lines, tidies line ends, and checks each line', () => {
    expect(validateParamValues(declared, { s: 'a=1\r\nb=2\n' })).toEqual({ s: 'a=1\nb=2\n' });
    expect(() => validateParamValues(declared, { s: 'a=1\nbad' })).toThrow(/invalid format/);
    expect(() => validateParamValues(declared, { s: 'a=1\n\u0001' })).toThrow(/control characters/);
    expect(() => validateParamValues(declared, { s: 'a=1\nb=2\nc=3\nd=4' })).toThrow(/at most 3 lines/);
    expect(() => validateParamValues(declared, { s: 'a=' + 'x'.repeat(60) })).toThrow(/at most 50/);
  });
});

describe('screens, datasets and the menu', () => {
  it('accepts a complete spec and hands the browser the screens and the menu, not the scripts', () => {
    const r = validateWidgetSpec(base(), PERMS, 'pk');
    if (!r.ok) throw new Error(r.error);
    const pub = publicSpec(r.value) as unknown as Record<string, unknown>;
    expect(Object.keys(pub.screens as object)).toEqual(['edit', 'manage']);
    expect((pub.menu as unknown[]).length).toBe(1);
    expect(pub.scripts).toBeUndefined();
    expect(pub.datasets).toBeUndefined();
  });

  it('needs version 2', () => {
    const s = base(); s.version = 1; delete s.scripts; delete s.actions; delete s.datasets; delete s.screens; delete s.menu; s.screens = {};
    expect(validateWidgetSpec(s, PERMS, 'pk').ok).toBe(false);
  });

  it('checks datasets', () => {
    expect(bad(s => { s.datasets.one.script = 'nope'; }).ok).toBe(false);
    expect(bad(s => { s.datasets.one.permission = 'other.view'; }).ok).toBe(false);
    expect(bad(s => { s.datasets.one.cacheSec = 99999; }).ok).toBe(false);
  });

  it('checks that screens, loads, editors and the menu agree with the rest of the spec', () => {
    expect(bad(s => { s.screens.edit.load.cur.dataset = 'missing'; }).ok).toBe(false);
    expect(bad(s => { s.screens.edit.load.cur.args = {}; }).ok).toBe(false);                    // the dataset's script needs `name`
    expect(bad(s => { s.screens.edit.load.cur.args = { name: 'context.name', extra: 'context.x' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].screen = 'ghost'; }).ok).toBe(false);
    expect(bad(s => { s.menu[0].screen = 'ghost'; }).ok).toBe(false);
    expect(bad(s => { s.menu[0].permission = 'other.x'; }).ok).toBe(false);
    expect(bad(s => { s.screens.edit.blocks[0].submits[0].action = 'edit'; }).ok).toBe(false);   // cannot submit to a screen action
    expect(bad(s => { s.screens.edit.blocks[0].param = 'name'; }).ok).toBe(false);               // not a text parameter
    expect(bad(s => { s.screens.edit.blocks[0].submits[0].params = {}; }).ok).toBe(false);       // `name` would stay unfilled
    expect(bad(s => { s.screens.edit.blocks[0].submits[0].params = { name: 'context.name', zzz: 'context.x' }; }).ok).toBe(false);
    expect(bad(s => { s.actions[0].variants = [{ script: 'save' }]; }).ok).toBe(false);          // a screen action has no script
    expect(bad(s => { s.screens.edit.blocks[0].fields.push({ name: 'image', label: 'Again', input: 'text' }); }).ok).toBe(false);
    expect(bad(s => { s.screens.edit.blocks[0].fields[3] = { name: 'net', label: 'N', input: 'select' }; }).ok).toBe(false);   // a select needs options
  });
});

describe('the editor', () => {
  const r = validateWidgetSpec(base(), PERMS, 'pk');
  if (!r.ok) throw new Error(r.error);
  const screen = r.value.screens!.edit;
  const editor = screen.blocks[0] as Extract<(typeof screen.blocks)[number], { type: 'editor' }>;
  const ctx = {
    context: { name: 'web' },
    datasets: { cur: { settings: { image: 'nginx:1', env: ['A=1', 'B=two words'], tty: true } }, nets: [{ name: 'bridge' }, { name: 'backend' }] },
  };

  it('starts from the context and builds the settings blob in field order', () => {
    const values = editorInitial(editor.fields, ctx);
    expect(values).toMatchObject({ image: 'nginx:1', env: ['A=1', 'B=two words'], tty: true, priv: false });
    // (a select starts on its first option when nothing is set)
    expect(serializeEditor(editor.fields, values)).toBe('image=nginx:1\nenv=A=1\nenv=B=two words\ntty=true\nnetwork=bridge\nprivileged=false');
    values.net = 'backend'; values.env = ['A=1', '', 'C=3\nD=4'];
    expect(serializeEditor(editor.fields, values)).toBe('image=nginx:1\nenv=A=1\nenv=C=3 D=4\ntty=true\nnetwork=backend\nprivileged=false');   // empty rows dropped, no row can add a line
  });

  it('builds select options from a list, warns about risky fields, and says what is missing', () => {
    expect(editorOptions(editor.fields[3], ctx)).toEqual([{ value: 'bridge', label: 'bridge' }, { value: 'backend', label: 'backend' }]);
    const values = editorInitial(editor.fields, ctx);
    expect(editorWarnings(editor.fields, values)).toEqual([]);
    values.priv = true;
    expect(editorWarnings(editor.fields, values)).toEqual(['Gives the container the host.']);
    values.image = ' ';
    expect(editorMissing(editor.fields, values)).toEqual(['Image']);
  });

  it('fills the action parameters: the blob, the context, and nothing else', () => {
    const action = r.value.actions.find(a => a.id === 'save')!;
    const values = editorInitial(editor.fields, ctx);
    const { params, missing } = editorSubmitParams(action, editor.submits[0], editor.param, editor.fields, values, ctx);
    expect(missing).toEqual([]);
    expect(params.name).toBe('web');
    expect(String(params.settings).startsWith('image=nginx:1\n')).toBe(true);
    // what would reach the script passes the parameter rules too
    expect(() => validateParamValues(action.params, params)).not.toThrow();
  });

  it('works out the arguments of a dataset from the context', () => {
    expect(screenArgs({ name: 'context.name', kind: 'literal:all' }, ctx)).toEqual({ name: 'web', kind: 'all' });
    expect(screenArgs({ name: 'context.missing' }, ctx)).toEqual({});
  });
});
