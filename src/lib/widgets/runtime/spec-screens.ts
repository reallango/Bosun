/**
 * Screens of a package widget (spec version 2): what a package adds on top of the widget's own view so that a whole
 * management UI lives in the package and nothing about it is built into Bosun.
 *
 *  - `datasets`  named read-only scripts a screen loads on demand (a list of images, the settings of one container). They run
 *                as the account the script declares, with parameters validated like any script parameter, and need a permission.
 *  - `screens`   a `dialog` (a pop-up opened from a menu entry or from the icon of a row) or a `page` (a full page opened from a
 *                menu entry), built from the layout blocks (tabs, editor, tables through `view` blocks, forms, notices ...).
 *  - `menu`      entries of the widget's ⋮ menu that open a screen.
 *
 * A screen reads `context` (the row it was opened for, when it is a row action) and `datasets.<alias>` (what its `load` fetched).
 * Pure (no I/O).
 */
import type { ActionSpec, ParamSpec, ViewSpec } from './spec';
import { fail, FIELD_RE, ID_RE, intIn, isObj, text, type Validated } from './spec-util';
import { validateLayout, type Block, type ScriptSpec } from './spec-v2';
import type { FieldSpec } from './spec';

export const MAX_DATASETS = 20;
export const MAX_SCREENS = 12;
export const MAX_MENU = 6;
export const SCREEN_SIZES = ['md', 'lg', 'xl'] as const;
export const MENU_ICONS = ['plus', 'settings', 'layout-grid', 'list', 'package', 'download', 'terminal', 'refresh-cw', 'info'] as const;

export interface DatasetSpec {
  /** A key of `scripts`. */
  script: string;
  /** How long a result is reused (seconds); 0 = always run. */
  cacheSec: number;
  /** The permission needed to load it (one the package declares). */
  permission: string;
}

export interface ScreenLoad {
  dataset: string;
  /** Script parameter -> a path into the screen's context (`context.name`) or `literal:<text>`. */
  args: Record<string, string>;
}

export interface ScreenSpec {
  kind: 'dialog' | 'page';
  /** A `{template}` over the screen's context. */
  title: string;
  description?: string;
  size: (typeof SCREEN_SIZES)[number];
  /** alias -> dataset, loaded when the screen opens (and again when the person presses Reload). */
  load: Record<string, ScreenLoad>;
  blocks: Block[];
  /** Pages only: close the dialog or leave the page after a submit succeeded (dialogs close by default). */
  keepOpenAfterSubmit: boolean;
}

export interface MenuEntry {
  id: string;
  label: string;
  icon?: (typeof MENU_ICONS)[number];
  screen: string;
  permission?: string;
}

const LITERAL_RE = /^[A-Za-z0-9_.:/ -]{0,100}$/;

export function validateDatasets(raw: unknown, scripts: Record<string, ScriptSpec>, own: ReadonlySet<string>): Validated<Record<string, DatasetSpec>> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isObj(raw)) return fail('"datasets" must be an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_DATASETS) return fail(`"datasets" may define at most ${MAX_DATASETS} datasets`);
  const out: Record<string, DatasetSpec> = {};
  for (const [id, d] of entries) {
    const where = `dataset "${id}"`;
    if (!ID_RE.test(id)) return fail(`${where}: ids are lowercase letters, digits and underscores`);
    if (!isObj(d)) return fail(`${where} must be an object`);
    if (typeof d.script !== 'string' || !(d.script in scripts)) return fail(`${where}: "script" must name one of the package scripts`);
    const cacheSec = intIn(d.cacheSec, 0, 3600, 10);
    if (cacheSec === null) return fail(`${where}: cacheSec must be 0-3600`);
    if (typeof d.permission !== 'string' || !own.has(d.permission)) return fail(`${where}: "permission" must be one of the permissions this package declares`);
    out[id] = { script: d.script, cacheSec, permission: d.permission };
  }
  return { ok: true, value: out };
}

type InnerView = (raw: unknown) => Validated<ViewSpec>;
type Fields = (raw: unknown, where: string) => Validated<FieldSpec[]>;

export function validateScreens(
  raw: unknown, actions: ActionSpec[], datasets: Record<string, DatasetSpec>, scripts: Record<string, ScriptSpec>, innerView: InnerView, fields: Fields,
): Validated<Record<string, ScreenSpec>> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isObj(raw)) return fail('"screens" must be an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCREENS) return fail(`"screens" may define at most ${MAX_SCREENS} screens`);
  const actionIds = new Set(actions.map(a => a.id));
  const out: Record<string, ScreenSpec> = {};
  for (const [id, s] of entries) {
    const where = `screen "${id}"`;
    if (!ID_RE.test(id)) return fail(`${where}: ids are lowercase letters, digits and underscores`);
    if (!isObj(s)) return fail(`${where} must be an object`);
    if (s.kind !== 'dialog' && s.kind !== 'page') return fail(`${where}: "kind" must be "dialog" or "page"`);
    const title = text(s.title, 120);
    if (!title) return fail(`${where}: a title is required`);
    const description = s.description === undefined ? undefined : text(s.description, 300);
    if (description === null) return fail(`${where}: "description" must be text`);
    const size = s.size === undefined ? 'lg' : s.size;
    if (!(SCREEN_SIZES as readonly string[]).includes(String(size))) return fail(`${where}: "size" must be ${SCREEN_SIZES.join(', ')}`);
    const load: Record<string, ScreenLoad> = {};
    if (s.load !== undefined) {
      if (!isObj(s.load) || Object.keys(s.load).length > 8) return fail(`${where}: "load" must be an object of up to 8 datasets`);
      for (const [alias, l] of Object.entries(s.load)) {
        if (!ID_RE.test(alias)) return fail(`${where}: load alias "${alias}" must be lowercase letters, digits and underscores`);
        if (!isObj(l) || typeof l.dataset !== 'string' || !(l.dataset in datasets)) return fail(`${where}: load "${alias}" must name a dataset of this widget`);
        const script = scripts[datasets[l.dataset].script];
        const args: Record<string, string> = {};
        if (l.args !== undefined) {
          if (!isObj(l.args)) return fail(`${where}: load "${alias}": "args" must map script parameters to paths`);
          for (const [name, path] of Object.entries(l.args)) {
            if (!(name in script.params)) return fail(`${where}: load "${alias}": the script has no parameter "${name}"`);
            const lit = typeof path === 'string' && path.startsWith('literal:') && LITERAL_RE.test(path.slice(8));
            if (typeof path !== 'string' || (!lit && !FIELD_RE.test(path))) return fail(`${where}: load "${alias}": argument "${name}" must be a context path such as "context.name", or "literal:<text>"`);
            args[name] = path;
          }
        }
        for (const [name, p] of Object.entries(script.params)) {
          if (!(name in args) && p.default === undefined) return fail(`${where}: load "${alias}": the dataset's script needs the parameter "${name}" in "args"`);
        }
        load[alias] = { dataset: l.dataset, args };
      }
    }
    const blocks = validateLayout(s.blocks, actionIds, innerView, fields);
    if (!blocks.ok) return fail(`${where}: ${blocks.error}`);
    const bad = checkEditors(blocks.value, actions);
    if (bad) return fail(`${where}: ${bad}`);
    out[id] = { kind: s.kind, title, ...(description ? { description } : {}), size: size as ScreenSpec['size'], load, blocks: blocks.value, keepOpenAfterSubmit: s.keepOpenAfterSubmit === true };
  }
  return { ok: true, value: out };
}

/** Every submit of an editor must call an action that has the editor's text parameter and only parameters the editor can fill. */
function checkEditors(blocks: Block[], actions: ActionSpec[]): string | null {
  const byId = new Map(actions.map(a => [a.id, a]));
  for (const b of blocks) {
    if (b.type === 'section' || b.type === 'tabs') {
      const inner = b.type === 'section' ? [b.blocks] : b.tabs.map(t => t.blocks);
      for (const list of inner) { const e = checkEditors(list, actions); if (e) return e; }
    }
    if (b.type !== 'editor') continue;
    for (const s of b.submits) {
      const a = byId.get(s.action);
      if (!a) return `an editor submits to the unknown action "${s.action}"`;
      if (a.kind === 'terminal' || a.kind === 'screen') return `an editor cannot submit to the ${a.kind} action "${a.id}"`;
      const p: ParamSpec | undefined = a.params[b.param];
      if (!p || p.type !== 'text') return `action "${a.id}" must declare "${b.param}" as a text parameter to receive the editor's settings`;
      for (const [name, spec] of Object.entries(a.params)) {
        if (name === b.param) continue;
        if (!(name in s.params) && spec.default === undefined) return `the submit "${s.label}" does not fill the parameter "${name}" of action "${a.id}" (map it in "params" or give the parameter a default)`;
      }
      for (const name of Object.keys(s.params)) if (!(name in a.params)) return `the submit "${s.label}" fills "${name}", which action "${a.id}" does not declare`;
    }
  }
  return null;
}

export function validateMenu(raw: unknown, screens: Record<string, ScreenSpec>, own: ReadonlySet<string>): Validated<MenuEntry[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_MENU) return fail(`"menu" must be a list of up to ${MAX_MENU} entries`);
  const out: MenuEntry[] = [];
  for (const m of raw as unknown[]) {
    if (!isObj(m) || typeof m.id !== 'string' || !ID_RE.test(m.id) || out.some(x => x.id === m.id)) return fail('each menu entry needs a unique "id" (lowercase letters, digits, underscores)');
    const label = text(m.label, 40);
    if (!label) return fail(`menu entry "${m.id}" needs a label`);
    if (typeof m.screen !== 'string' || !(m.screen in screens)) return fail(`menu entry "${m.id}": "screen" must name a screen of this widget`);
    if (m.icon !== undefined && !(MENU_ICONS as readonly string[]).includes(String(m.icon))) return fail(`menu entry "${m.id}": "icon" must be one of ${MENU_ICONS.join(', ')}`);
    if (m.permission !== undefined && (typeof m.permission !== 'string' || !own.has(m.permission))) return fail(`menu entry "${m.id}": "permission" must be one of the permissions this package declares`);
    out.push({ id: m.id, label, ...(m.icon ? { icon: m.icon as MenuEntry['icon'] } : {}), screen: m.screen, ...(m.permission ? { permission: m.permission as string } : {}) });
  }
  return { ok: true, value: out };
}

