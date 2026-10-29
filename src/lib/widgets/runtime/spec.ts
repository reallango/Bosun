/**
 * The declarative widget spec: what a widget package's `spec` may contain, and how it is validated.
 *
 * A spec describes where a widget's data comes from, how it is shown, and which actions it offers.
 * It is data, not code: there is no scripting, only fixed building blocks. The parts that touch a host
 * are the commands in `data` and `actions`; those are written by the package author, reviewed by the
 * admin who installs the package, and run with the parameter rules below:
 *
 *  - an action's command may only use `{{name}}` placeholders for parameters the action declares;
 *  - every parameter has a strict type (a string must carry an anchored pattern or a fixed list of values);
 *  - Bosun quotes each value as one shell word itself, so authors must not quote placeholders;
 *  - each action names a permission the package declares, so nothing runs without an explicit grant.
 *
 * Pure (no I/O) so it can be used from the routes, the browser and the tests.
 */

export const SPEC_VERSION = 1;
export const SNAPSHOT_SECTIONS = ['cpu_memory', 'disks', 'gpus', 'system', 'net_rates', 'network', 'services', 'ollama', 'docker', 'updates'] as const;
export const ICONS = ['play', 'square', 'rotate-cw', 'scroll-text', 'trash-2', 'download', 'upload', 'power', 'refresh-cw', 'terminal-square', 'pause', 'info'] as const;
export const DOT_COLORS = ['green', 'amber', 'red', 'gray', 'blue'] as const;
export const FORMATS = ['text', 'bytes', 'percent', 'badge'] as const;
export const PARSERS = ['json', 'jsonlines', 'lines', 'text'] as const;

export type RunAs = 'service' | 'shell';

export interface Cond {
  field: string;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  in?: (string | number | boolean)[];
  exists?: boolean;
}

export type DataSpec =
  | { source: 'snapshot'; section: string; path?: string; map?: Record<string, string>; permission: string }
  | {
      source: 'command'; as: RunAs; command: string; windowsCommand?: string; parse: (typeof PARSERS)[number];
      path?: string; map?: Record<string, string>; cacheSec: number; timeoutSec: number; permission: string;
    };

export type ParamSpec =
  | { type: 'string'; pattern?: string; values?: string[]; maxLength: number; from?: string; default?: string; description?: string }
  | { type: 'number'; min: number; max: number; integer: boolean; from?: string; default?: number; description?: string }
  | { type: 'boolean'; from?: string; default?: boolean; description?: string };

export interface ActionSpec {
  id: string;
  label: string;
  description?: string;
  icon?: (typeof ICONS)[number];
  permission: string;
  /** `command` runs a command on the host; `terminal` opens the web terminal in a container (see `terminal`). */
  kind: 'command' | 'terminal';
  /** Terminal actions only: the row field that holds the container name. */
  terminal?: { container: string };
  as: RunAs;
  command: string;
  windowsCommand?: string;
  params: Record<string, ParamSpec>;
  timeoutSec: number;
  when?: Cond;
  confirm?: { title: string; text?: string; destructive: boolean };
  result: 'toast' | 'text' | 'none';
  after: 'refresh' | 'none';
}

export interface ViewSpec {
  type: 'list' | 'table' | 'text';
  empty?: string;
  summary?: { label: string; where?: Cond }[];
  filter?: { fields: string[]; placeholder?: string };
  toggles?: { key: string; label: string; default: boolean; hideWhen: Cond }[];
  row?: { dot?: { field: string; colors: Record<string, (typeof DOT_COLORS)[number]> }; title: string; subtitle?: string; badge?: string; actions: string[] };
  columns?: { title: string; value: string; format: (typeof FORMATS)[number] }[];
  rowActions?: string[];
  text?: string;
}

export interface WidgetSpec {
  version: number;
  data: DataSpec;
  view: ViewSpec;
  actions: ActionSpec[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PARAM_RE = /^[a-z][a-zA-Z0-9_]{0,29}$/;
const PLACEHOLDER_RE = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;
export const MAX_COMMAND_LENGTH = 2000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null);
const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

function intIn(v: unknown, min: number, max: number, def: number): number | null {
  if (v === undefined) return def;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function cond(raw: unknown, where: string): Validated<Cond> {
  if (!isObj(raw)) return fail(`${where}: must be an object like {"field": "state", "equals": "running"}`);
  if (typeof raw.field !== 'string' || !FIELD_RE.test(raw.field)) return fail(`${where}: "field" must be a field name`);
  const c: Cond = { field: raw.field };
  let n = 0;
  if (raw.equals !== undefined) { if (!scalar(raw.equals)) return fail(`${where}: "equals" must be a string, number or boolean`); c.equals = raw.equals; n++; }
  if (raw.notEquals !== undefined) { if (!scalar(raw.notEquals)) return fail(`${where}: "notEquals" must be a string, number or boolean`); c.notEquals = raw.notEquals; n++; }
  if (raw.in !== undefined) {
    if (!Array.isArray(raw.in) || raw.in.length > 50 || !raw.in.every(scalar)) return fail(`${where}: "in" must be a list of up to 50 values`);
    c.in = raw.in as (string | number | boolean)[]; n++;
  }
  if (raw.exists !== undefined) { if (typeof raw.exists !== 'boolean') return fail(`${where}: "exists" must be true or false`); c.exists = raw.exists; n++; }
  if (n !== 1) return fail(`${where}: give exactly one of equals, notEquals, in or exists`);
  return { ok: true, value: c };
}

function fieldMap(raw: unknown, where: string): Validated<Record<string, string> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw) || Object.keys(raw).length > 40) return fail(`${where}: "map" must be an object of up to 40 entries`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || !FIELD_RE.test(v)) return fail(`${where}: "map" entries go from a new field name to a source field name`);
    out[k] = v;
  }
  return { ok: true, value: out };
}

function optPath(raw: unknown, where: string): Validated<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !FIELD_RE.test(raw)) return fail(`${where}: "path" must be a dotted field name`);
  return { ok: true, value: raw };
}

/** The `{{name}}` placeholders in a command template, in order of appearance. */
export function placeholders(command: string): string[] {
  return Array.from(command.matchAll(PLACEHOLDER_RE)).map(m => m[1]);
}

function validateCommand(command: unknown, params: Record<string, ParamSpec> | null, where: string): Validated<string> {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) return fail(`${where}: a command is required (max ${MAX_COMMAND_LENGTH} characters)`);
  if (params === null) return { ok: true, value: command };
  for (const m of command.matchAll(PLACEHOLDER_RE)) {
    if (!(m[1] in params)) return fail(`${where}: the command uses {{${m[1]}}} but no parameter "${m[1]}" is declared`);
    const before = command[(m.index ?? 0) - 1];
    const after = command[(m.index ?? 0) + m[0].length];
    if (before === "'" || before === '"' || after === "'" || after === '"') {
      return fail(`${where}: do not put quotes around {{${m[1]}}}; Bosun quotes parameter values itself`);
    }
  }
  return { ok: true, value: command };
}

function validateParam(name: string, raw: unknown, where: string): Validated<ParamSpec> {
  if (!PARAM_RE.test(name)) return fail(`${where}: parameter names are letters, digits and underscores, starting with a lowercase letter`);
  if (!isObj(raw)) return fail(`${where}: parameter "${name}" must be an object`);
  const from = raw.from === undefined ? undefined : (typeof raw.from === 'string' && FIELD_RE.test(raw.from) ? raw.from : null);
  if (from === null) return fail(`${where}: parameter "${name}": "from" must be a field name`);
  const description = raw.description === undefined ? undefined : text(raw.description, 200);
  if (description === null) return fail(`${where}: parameter "${name}": description is too long`);
  const common = { ...(from ? { from } : {}), ...(description ? { description } : {}) };
  // A default is only a value the widget's form starts with; callers of the API must still send every parameter.
  const dflt = raw.default;
  if (raw.type === 'boolean') {
    if (dflt !== undefined && typeof dflt !== 'boolean') return fail(`${where}: default of "${name}" must be true or false`);
    return { ok: true, value: { type: 'boolean', ...common, ...(dflt !== undefined ? { default: dflt } : {}) } };
  }
  if (raw.type === 'number') {
    if (typeof raw.min !== 'number' || typeof raw.max !== 'number' || !Number.isFinite(raw.min) || !Number.isFinite(raw.max) || raw.min > raw.max) {
      return fail(`${where}: number parameter "${name}" needs numeric "min" and "max"`);
    }
    if (dflt !== undefined && (typeof dflt !== 'number' || dflt < raw.min || dflt > raw.max)) return fail(`${where}: default of "${name}" must be a number between min and max`);
    return { ok: true, value: { type: 'number', min: raw.min, max: raw.max, integer: raw.integer !== false, ...common, ...(dflt !== undefined ? { default: dflt as number } : {}) } };
  }
  if (raw.type === 'string') {
    const maxLength = intIn(raw.maxLength, 1, 200, 200);
    if (maxLength === null) return fail(`${where}: "maxLength" of "${name}" must be 1-200`);
    let values: string[] | undefined;
    if (raw.values !== undefined) {
      if (!Array.isArray(raw.values) || raw.values.length < 1 || raw.values.length > 100 || !raw.values.every(v => typeof v === 'string' && v.length <= 200)) {
        return fail(`${where}: "values" of "${name}" must be a list of 1-100 strings`);
      }
      values = raw.values as string[];
    }
    let pattern: string | undefined;
    if (raw.pattern !== undefined) {
      if (typeof raw.pattern !== 'string' || raw.pattern.length > 200 || !raw.pattern.startsWith('^') || !raw.pattern.endsWith('$')) {
        return fail(`${where}: "pattern" of "${name}" must be a regular expression anchored with ^ and $ (max 200 characters)`);
      }
      try { new RegExp(raw.pattern); } catch { return fail(`${where}: "pattern" of "${name}" is not a valid regular expression`); }
      pattern = raw.pattern;
    }
    if (!pattern && !values) return fail(`${where}: string parameter "${name}" needs an anchored "pattern" or a list of "values"`);
    if (dflt !== undefined && (typeof dflt !== 'string' || dflt.length > maxLength || (pattern && !new RegExp(pattern).test(dflt)) || (values && !values.includes(dflt)))) return fail(`${where}: default of "${name}" does not satisfy its own rules`);
    return { ok: true, value: { type: 'string', maxLength, ...(pattern ? { pattern } : {}), ...(values ? { values } : {}), ...common, ...(dflt !== undefined ? { default: dflt as string } : {}) } };
  }
  return fail(`${where}: parameter "${name}" has an unknown type (use string, number or boolean)`);
}

function validateData(raw: unknown, ownPerms: ReadonlySet<string>): Validated<DataSpec> {
  if (!isObj(raw)) return fail('"data" is required');
  // Required: it decides who can see the widget on a dashboard and read its data.
  const perm = typeof raw.permission === 'string' && ownPerms.has(raw.permission) ? raw.permission : null;
  if (perm === null) return fail('data.permission is required and must be a permission this package declares: it decides who sees the widget and its data');
  const path = optPath(raw.path, 'data');
  if (!path.ok) return path;
  const map = fieldMap(raw.map, 'data');
  if (!map.ok) return map;
  const base = { ...(path.value ? { path: path.value } : {}), ...(map.value ? { map: map.value } : {}), permission: perm };
  if (raw.source === 'snapshot') {
    if (typeof raw.section !== 'string' || !(SNAPSHOT_SECTIONS as readonly string[]).includes(raw.section)) {
      return fail(`data.section must be one of: ${SNAPSHOT_SECTIONS.join(', ')}`);
    }
    return { ok: true, value: { source: 'snapshot', section: raw.section, ...base } };
  }
  if (raw.source === 'command') {
    if (raw.as !== 'service' && raw.as !== 'shell') return fail('data.as must be "service" (the privileged account) or "shell" (the non-admin account)');
    const command = validateCommand(raw.command, null, 'data');
    if (!command.ok) return command;
    let windowsCommand: string | undefined;
    if (raw.windowsCommand !== undefined) {
      const w = validateCommand(raw.windowsCommand, null, 'data.windowsCommand');
      if (!w.ok) return w;
      windowsCommand = w.value;
    }
    if (!(PARSERS as readonly string[]).includes(String(raw.parse))) return fail(`data.parse must be one of: ${PARSERS.join(', ')}`);
    const cacheSec = intIn(raw.cacheSec, 5, 300, 10);
    const timeoutSec = intIn(raw.timeoutSec, 1, 60, 20);
    if (cacheSec === null || timeoutSec === null) return fail('data.cacheSec must be 5-300 and data.timeoutSec 1-60');
    return {
      ok: true,
      value: { source: 'command', as: raw.as, command: command.value, ...(windowsCommand ? { windowsCommand } : {}), parse: raw.parse as (typeof PARSERS)[number], cacheSec, timeoutSec, ...base },
    };
  }
  return fail('data.source must be "snapshot" or "command"');
}

function validateAction(raw: unknown, ownPerms: ReadonlySet<string>): Validated<ActionSpec> {
  if (!isObj(raw)) return fail('each action must be an object');
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID_RE.test(id)) return fail(`action id "${id}" must be lowercase letters, digits and underscores`);
  const where = `action "${id}"`;
  const label = text(raw.label, 60);
  if (!label) return fail(`${where}: a label is required (max 60 characters)`);
  const description = raw.description === undefined ? undefined : text(raw.description, 300);
  if (description === null) return fail(`${where}: description is too long`);
  if (raw.icon !== undefined && !(ICONS as readonly string[]).includes(String(raw.icon))) return fail(`${where}: unknown icon (use one of: ${ICONS.join(', ')})`);
  if (typeof raw.permission !== 'string' || !ownPerms.has(raw.permission)) return fail(`${where}: "permission" must be a permission this package declares`);

  // A terminal action opens the web terminal in a container. It runs nothing itself: the person types their
  // own login there, and only Full access users get a web terminal at all. (API access to a container shell is
  // the separate API terminal, granted with its own permission.)
  if (raw.terminal !== undefined) {
    if (!isObj(raw.terminal) || typeof raw.terminal.container !== 'string' || !FIELD_RE.test(raw.terminal.container)) {
      return fail(`${where}: "terminal" needs "container": the row field that holds the container name`);
    }
    const hasCommand = (typeof raw.command === 'string' && raw.command !== '') || raw.windowsCommand !== undefined
      || (isObj(raw.params) && Object.keys(raw.params).length > 0);
    if (hasCommand) return fail(`${where}: a terminal action opens the web terminal and cannot also have a command or parameters`);
    let when: Cond | undefined;
    if (raw.when !== undefined) {
      const c = cond(raw.when, `${where} "when"`);
      if (!c.ok) return c;
      when = c.value;
    }
    return {
      ok: true,
      value: {
        id, label, ...(description ? { description } : {}), ...(raw.icon ? { icon: raw.icon as ActionSpec['icon'] } : {}), permission: raw.permission,
        kind: 'terminal', terminal: { container: raw.terminal.container }, as: 'service', command: '', params: {}, timeoutSec: 30,
        ...(when ? { when } : {}), result: 'none', after: 'none',
      },
    };
  }

  if (raw.as !== 'service' && raw.as !== 'shell') return fail(`${where}: "as" must be "service" (the privileged account) or "shell" (the non-admin account)`);

  const params: Record<string, ParamSpec> = {};
  if (raw.params !== undefined) {
    if (!isObj(raw.params) || Object.keys(raw.params).length > 10) return fail(`${where}: "params" must be an object of up to 10 parameters`);
    for (const [name, p] of Object.entries(raw.params)) {
      const v = validateParam(name, p, where);
      if (!v.ok) return v;
      params[name] = v.value;
    }
  }
  const command = validateCommand(raw.command, params, where);
  if (!command.ok) return command;
  let windowsCommand: string | undefined;
  if (raw.windowsCommand !== undefined) {
    const w = validateCommand(raw.windowsCommand, params, `${where} windowsCommand`);
    if (!w.ok) return w;
    windowsCommand = w.value;
  }
  const timeoutSec = intIn(raw.timeoutSec, 1, 300, 30);
  if (timeoutSec === null) return fail(`${where}: timeoutSec must be 1-300`);
  let when: Cond | undefined;
  if (raw.when !== undefined) {
    const c = cond(raw.when, `${where} "when"`);
    if (!c.ok) return c;
    when = c.value;
  }
  let confirm: ActionSpec['confirm'];
  if (raw.confirm !== undefined) {
    if (!isObj(raw.confirm)) return fail(`${where}: "confirm" must be an object with a title`);
    const title = text(raw.confirm.title, 120);
    const body = raw.confirm.text === undefined ? undefined : text(raw.confirm.text, 400);
    if (!title || body === null) return fail(`${where}: confirm needs a title (max 120 characters) and optional text (max 400)`);
    confirm = { title, ...(body ? { text: body } : {}), destructive: raw.confirm.destructive === true };
  }
  const result = raw.result === undefined ? 'toast' : raw.result;
  if (result !== 'toast' && result !== 'text' && result !== 'none') return fail(`${where}: result must be toast, text or none`);
  const after = raw.after === undefined ? 'none' : raw.after;
  if (after !== 'refresh' && after !== 'none') return fail(`${where}: after must be refresh or none`);
  return {
    ok: true,
    value: {
      id, label, ...(description ? { description } : {}), ...(raw.icon ? { icon: raw.icon as ActionSpec['icon'] } : {}), permission: raw.permission, kind: 'command', as: raw.as,
      command: command.value, ...(windowsCommand ? { windowsCommand } : {}), params, timeoutSec, ...(when ? { when } : {}), ...(confirm ? { confirm } : {}), result, after,
    },
  };
}

function validateView(raw: unknown, actionIds: ReadonlySet<string>): Validated<ViewSpec> {
  if (!isObj(raw)) return fail('"view" is required');
  if (raw.type !== 'list' && raw.type !== 'table' && raw.type !== 'text') return fail('view.type must be "list", "table" or "text"');
  const view: ViewSpec = { type: raw.type };
  if (raw.empty !== undefined) {
    const e = text(raw.empty, 200);
    if (!e) return fail('view.empty must be text');
    view.empty = e;
  }
  const refActions = (list: unknown, where: string): Validated<string[]> => {
    if (list === undefined) return { ok: true, value: [] };
    if (!Array.isArray(list) || list.length > 10 || !list.every(a => typeof a === 'string' && actionIds.has(a))) return fail(`${where} must list ids of actions this widget declares`);
    return { ok: true, value: list as string[] };
  };
  if (raw.type === 'text') {
    const t = text(raw.text, 1000);
    if (!t) return fail('a text view needs "text", for example "{output}"');
    view.text = t;
    return { ok: true, value: view };
  }
  if (raw.summary !== undefined) {
    if (!Array.isArray(raw.summary) || raw.summary.length > 6) return fail('view.summary must be a list of up to 6 entries');
    view.summary = [];
    for (const s of raw.summary as unknown[]) {
      if (!isObj(s)) return fail('view.summary entries must be objects');
      const label = text(s.label, 40);
      if (!label) return fail('each view.summary entry needs a label');
      if (s.where === undefined) view.summary.push({ label });
      else { const c = cond(s.where, 'view.summary "where"'); if (!c.ok) return c; view.summary.push({ label, where: c.value }); }
    }
  }
  if (raw.filter !== undefined) {
    if (!isObj(raw.filter) || !Array.isArray(raw.filter.fields) || raw.filter.fields.length < 1 || raw.filter.fields.length > 10 || !raw.filter.fields.every(f => typeof f === 'string' && FIELD_RE.test(f))) {
      return fail('view.filter needs "fields": a list of field names to search');
    }
    const placeholder = raw.filter.placeholder === undefined ? undefined : text(raw.filter.placeholder, 40);
    if (placeholder === null) return fail('view.filter.placeholder is too long');
    view.filter = { fields: raw.filter.fields as string[], ...(placeholder ? { placeholder } : {}) };
  }
  if (raw.toggles !== undefined) {
    if (!Array.isArray(raw.toggles) || raw.toggles.length > 4) return fail('view.toggles must be a list of up to 4 entries');
    view.toggles = [];
    for (const t of raw.toggles as unknown[]) {
      if (!isObj(t) || typeof t.key !== 'string' || !ID_RE.test(t.key)) return fail('each view.toggles entry needs a "key"');
      const label = text(t.label, 40);
      if (!label) return fail('each view.toggles entry needs a label');
      const c = cond(t.hideWhen, 'view.toggles "hideWhen"');
      if (!c.ok) return c;
      view.toggles.push({ key: t.key, label, default: t.default !== false, hideWhen: c.value });
    }
  }
  if (raw.type === 'list') {
    if (!isObj(raw.row)) return fail('a list view needs "row"');
    const title = text(raw.row.title, 200);
    if (!title) return fail('view.row.title is required');
    const row: NonNullable<ViewSpec['row']> = { title, actions: [] };
    for (const k of ['subtitle', 'badge'] as const) {
      if (raw.row[k] !== undefined) {
        const v = text(raw.row[k], 200);
        if (!v) return fail(`view.row.${k} must be text`);
        row[k] = v;
      }
    }
    if (raw.row.dot !== undefined) {
      const d = raw.row.dot;
      if (!isObj(d) || typeof d.field !== 'string' || !FIELD_RE.test(d.field) || !isObj(d.colors)) return fail('view.row.dot needs "field" and "colors"');
      const colors: Record<string, (typeof DOT_COLORS)[number]> = {};
      for (const [k, v] of Object.entries(d.colors)) {
        if (!(DOT_COLORS as readonly string[]).includes(String(v)) || Object.keys(d.colors).length > 30) return fail(`view.row.dot colors must be one of: ${DOT_COLORS.join(', ')}`);
        colors[k] = v as (typeof DOT_COLORS)[number];
      }
      row.dot = { field: d.field, colors };
    }
    const a = refActions(raw.row.actions, 'view.row.actions');
    if (!a.ok) return a;
    row.actions = a.value;
    view.row = row;
  } else {
    if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > 12) return fail('a table view needs 1-12 "columns"');
    view.columns = [];
    for (const c of raw.columns as unknown[]) {
      if (!isObj(c)) return fail('each column must be an object');
      const title = text(c.title, 40);
      const value = text(c.value, 200);
      if (!title || !value) return fail('each column needs a title and a value');
      const format = c.format === undefined ? 'text' : c.format;
      if (!(FORMATS as readonly string[]).includes(String(format))) return fail(`column format must be one of: ${FORMATS.join(', ')}`);
      view.columns.push({ title, value, format: format as (typeof FORMATS)[number] });
    }
    const a = refActions(raw.rowActions, 'view.rowActions');
    if (!a.ok) return a;
    view.rowActions = a.value;
  }
  return { ok: true, value: view };
}

/** Validate a widget's `spec`. `ownPermissions` are the permission ids the package declares. */
export function validateWidgetSpec(raw: unknown, ownPermissions: readonly string[]): Validated<WidgetSpec> {
  if (!isObj(raw)) return fail('"spec" must be an object');
  if (raw.version !== SPEC_VERSION) return fail(`spec.version must be ${SPEC_VERSION}`);
  const own = new Set(ownPermissions);
  const data = validateData(raw.data, own);
  if (!data.ok) return data;
  const actions: ActionSpec[] = [];
  const ids = new Set<string>();
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > 20) return fail('"actions" must be a list of up to 20 actions');
    for (const a of raw.actions) {
      const v = validateAction(a, own);
      if (!v.ok) return v;
      if (ids.has(v.value.id)) return fail(`action "${v.value.id}" is listed twice`);
      ids.add(v.value.id);
      actions.push(v.value);
    }
  }
  const view = validateView(raw.view, ids);
  if (!view.ok) return view;
  return { ok: true, value: { version: SPEC_VERSION, data: data.value, view: view.value, actions } };
}

/** Does a row satisfy a condition? Used by the view and, for toggles and summaries, the renderer. */
export function evalCond(c: Cond, row: unknown): boolean {
  const v = getPath(row, c.field);
  if (c.exists !== undefined) return (v !== undefined && v !== null && v !== '') === c.exists;
  if (c.equals !== undefined) return v === c.equals || (v !== undefined && v !== null && String(v) === String(c.equals));
  if (c.notEquals !== undefined) return !(v === c.notEquals || (v !== undefined && v !== null && String(v) === String(c.notEquals)));
  if (c.in !== undefined) return c.in.some(x => v === x || (v !== undefined && v !== null && String(v) === String(x)));
  return false;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Obj)[part];
  }
  return cur;
}

/** Fill `{field}` references from a row (unknown fields become empty text). Single braces only; `{{` is not special here. */
export function fillTemplate(template: string, row: unknown): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g, (_, path: string) => {
    const v = getPath(row, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/**
 * The part of a spec the browser needs: how to draw the widget and which actions exist, but
 * not the commands that implement them.
 */
export function publicSpec(spec: WidgetSpec): Omit<WidgetSpec, 'data' | 'actions'> & {
  data: { source: DataSpec['source'] };
  actions: Omit<ActionSpec, 'command' | 'windowsCommand' | 'as' | 'timeoutSec'>[];
} {
  return {
    version: spec.version,
    view: spec.view,
    data: { source: spec.data.source },
    actions: spec.actions.map(a => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { command, windowsCommand, as, timeoutSec, ...rest } = a;
      return rest;
    }),
  };
}
