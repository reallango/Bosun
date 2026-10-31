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

import { cond, fail, FIELD_RE, ID_RE, PARAM_RE, intIn, isObj, scalar, text, validateParam, type Obj, type Validated } from './spec-util';
export type { Validated } from './spec-util';
import { validateLayout, validateLookups, validateScripts, validateState, validateVariants, type ActionVariant, type Block, type LookupSpec, type ScriptSpec, type StateSpec } from './spec-v2';
export type { ActionVariant, Block, LookupSpec, ScriptSpec, StateSpec } from './spec-v2';

export const SPEC_VERSION = 1;
/** Versions the validators accept. Version 2 adds scripts, state, lookups, script actions and layout views (spec-v2.ts). */
export const SPEC_VERSIONS = [1, 2] as const;
export const SNAPSHOT_SECTIONS = ['cpu_memory', 'disks', 'gpus', 'system', 'net_rates', 'network', 'services', 'docker', 'metrics'] as const;
export const ICONS = ['play', 'square', 'rotate-cw', 'scroll-text', 'trash-2', 'download', 'upload', 'power', 'refresh-cw', 'terminal-square', 'pause', 'info'] as const;
export const DOT_COLORS = ['green', 'amber', 'red', 'gray', 'blue'] as const;
export const FORMATS = ['text', 'bytes', 'percent', 'badge', 'bar', 'duration', 'mb', 'temp', 'ago'] as const;
export const PARSERS = ['json', 'jsonlines', 'lines', 'text'] as const;

export type RunAs = 'service' | 'shell';

export interface Cond {
  /** The value to test: a dotted path into the row (version 1) or into the context (`state.x`, `config.x`, `lookups.x`, ...). */
  field?: string;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  in?: (string | number | boolean)[];
  exists?: boolean;
  /** Version 2: numeric comparisons. */
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** Version 2: true when the version at `field` is newer than the version at this path (both x.y.z). */
  newerThan?: string;
  /** Version 2: combinations of conditions. */
  all?: Cond[];
  any?: Cond[];
  not?: Cond;
}

/** Keep the rows whose `field` equals the widget setting `config` (an instance setting from the widget's config_schema); `all` is the setting value that keeps every row. */
export interface ConfigFilter { field: string; config: string; all?: string; default?: string }

/** When the collected data matches `when`, the widget shows `message` (a `{field}` template over that data) instead of rows. */
export interface Unavailable { when: Cond; message: string }

interface DataCommon { filter?: ConfigFilter[]; unavailable?: Unavailable }

export type DataSpec =
  | ({ source: 'snapshot'; section: string; also?: string[]; server?: boolean; path?: string; map?: Record<string, string>; permission: string } & DataCommon)
  | ({
      /** Version 2: `script` names a package script that produces the data instead of an inline `command` (then empty); `args` gives its parameters from instance settings, `cacheSecFrom` takes the interval from one. */
      source: 'command'; as: RunAs; command: string; script?: string; args?: Record<string, string>; cacheSecFrom?: string; initialDelaySec?: number; windowsCommand?: string; parse: (typeof PARSERS)[number];
      path?: string; map?: Record<string, string>; cacheSec: number; timeoutSec: number; permission: string;
    } & DataCommon);

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
  /**
   * `command` runs a command on the host; `terminal` opens an interactive terminal running a command of the package (see `terminal`);
   * `script` (version 2) runs the first of `variants` whose condition holds.
   */
  kind: 'command' | 'terminal' | 'script';
  /** Script actions only. */
  variants?: ActionVariant[];
  /** Script actions only: the output of the script (parsed like `data.parse`) replaces the widget's stored data (a "check now" action). */
  stores?: 'data';
  /** Script actions only: run as a long-running job (answers 202; progress and result through the job endpoint). */
  job?: boolean;
  /**
   * Terminal actions only. `ref` is the row field that names what to open a terminal in (for example a container),
   * `refPattern` an anchored pattern the name must match, `command` the one command the terminal runs with `{{ref}}` in
   * its place (reviewed at install), and `check` (version 2) a package script, with a `ref` parameter, that API keys
   * must pass first: it may refuse (ERROR:) and may pin the target by printing `REF <exact name>`.
   */
  terminal?: { ref: string; refPattern: string; command: string; check?: string };
  as: RunAs;
  command: string;
  windowsCommand?: string;
  params: Record<string, ParamSpec>;
  timeoutSec: number;
  when?: Cond;
  /** `requireText`: a template (`{name}`) the person must type to confirm (for deleting something). */
  confirm?: { title: string; text?: string; destructive: boolean; requireText?: string };
  result: 'toast' | 'text' | 'none';
  after: 'refresh' | 'none';
}

/** One labelled value. `bar` (a template that gives 0-100) draws a gauge under it; `when` hides it for data it does not match. */
export interface FieldSpec { label: string; value: string; format: (typeof FORMATS)[number]; bar?: string; when?: Cond }

export interface ViewSpec {
  type: 'list' | 'table' | 'text' | 'fields' | 'chart' | 'layout';
  /** A layout view (version 2): sections, forms, buttons and the other views as blocks. */
  blocks?: Block[];
  /** A chart view: the history of tracked metrics, drawn as lines. `metrics` are the ones shown until a person picks others. */
  chart?: { metrics: string[] };
  /** A fields view: the labelled values (gauges, key and value pairs) of one data object. */
  fields?: FieldSpec[];
  empty?: string;
  summary?: { label: string; where?: Cond }[];
  filter?: { fields: string[]; placeholder?: string };
  toggles?: { key: string; label: string; default: boolean; hideWhen: Cond }[];
  row?: { dot?: { field: string; colors: Record<string, (typeof DOT_COLORS)[number]> }; title: string; subtitle?: string; badge?: string; actions: string[]; fields?: FieldSpec[] };
  columns?: { title: string; value: string; format: (typeof FORMATS)[number] }[];
  rowActions?: string[];
  text?: string;
}

export const METRIC_AGGS = ['count', 'sum', 'avg', 'min', 'max', 'first'] as const;

/**
 * A statistic the widget tracks over time (kept as history on the server). Without `from` it names a metric the
 * built-in collectors already produce (`cpu.usage`, `gpu*.util`; `*` matches a number) and only sets how long its
 * history is kept. With `from` the metric is computed from the widget's data on every collection, and its name
 * must start with the package id (`mypkg.running`). A retention left out uses the global setting.
 */
export interface MetricSpec {
  name: string;
  label?: string;
  unit?: string;
  rawHours?: number;
  rollup5mDays?: number;
  rollup1hDays?: number;
  from?: { field?: string; path?: string; agg: (typeof METRIC_AGGS)[number]; where?: Cond };
}

export interface WidgetSpec {
  version: number;
  data: DataSpec;
  view: ViewSpec;
  actions: ActionSpec[];
  metrics?: MetricSpec[];
  /** Version 2: host scripts of the package, the widget's state probe and its external lookups (see spec-v2.ts). */
  scripts?: Record<string, ScriptSpec>;
  state?: StateSpec;
  lookups?: Record<string, LookupSpec>;
}


const PLACEHOLDER_RE = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;
export const MAX_COMMAND_LENGTH = 2000;

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

const SETTING_RE = /^[a-z][a-zA-Z0-9_]{0,29}$/;

/** `data.filter` and `data.unavailable`, shared by both data sources. */
function dataExtras(raw: Obj): Validated<DataCommon> {
  const out: DataCommon = {};
  if (raw.filter !== undefined) {
    if (!Array.isArray(raw.filter) || raw.filter.length < 1 || raw.filter.length > 4) return fail('data.filter must be a list of 1-4 entries');
    out.filter = [];
    for (const f of raw.filter as unknown[]) {
      if (!isObj(f) || typeof f.field !== 'string' || !FIELD_RE.test(f.field) || typeof f.config !== 'string' || !SETTING_RE.test(f.config)) {
        return fail('each data.filter entry needs "field" (a row field) and "config" (the widget setting to compare it with)');
      }
      const all = f.all === undefined ? undefined : text(f.all, 40);
      const dflt = f.default === undefined ? undefined : text(f.default, 40);
      if (all === null || dflt === null) return fail('data.filter "all" and "default" must be short text');
      out.filter.push({ field: f.field, config: f.config, ...(all ? { all } : {}), ...(dflt ? { default: dflt } : {}) });
    }
  }
  if (raw.unavailable !== undefined) {
    if (!isObj(raw.unavailable)) return fail('data.unavailable must be an object with "when" and "message"');
    const c = cond(raw.unavailable.when, 'data.unavailable "when"');
    if (!c.ok) return c;
    const message = text(raw.unavailable.message, 300);
    if (!message) return fail('data.unavailable needs a message (max 300 characters)');
    out.unavailable = { when: c.value, message };
  }
  return { ok: true, value: out };
}

/** Keep the rows that match the widget's settings (a setting that is missing falls back to the entry's default). */
export function applyConfigFilters(rows: unknown, filters: ConfigFilter[] | undefined, config: Record<string, unknown>): unknown {
  if (!filters || !Array.isArray(rows)) return rows;
  return filters.reduce<unknown[]>((list, f) => {
    const want = String(config[f.config] ?? f.default ?? f.all ?? '');
    if (want === '' || (f.all !== undefined && want === f.all)) return list;
    return list.filter(r => String(getPath(r, f.field) ?? '') === want);
  }, rows);
}

function validateData(raw: unknown, ownPerms: ReadonlySet<string>, v2?: { scripts: Record<string, ScriptSpec> }): Validated<DataSpec> {
  if (!isObj(raw)) return fail('"data" is required');
  // Required: it decides who can see the widget on a dashboard and read its data.
  const perm = typeof raw.permission === 'string' && ownPerms.has(raw.permission) ? raw.permission : null;
  if (perm === null) return fail('data.permission is required and must be a permission this package declares: it decides who sees the widget and its data');
  const path = optPath(raw.path, 'data');
  if (!path.ok) return path;
  const map = fieldMap(raw.map, 'data');
  if (!map.ok) return map;
  const extras = dataExtras(raw);
  if (!extras.ok) return extras;
  const base = { ...(path.value ? { path: path.value } : {}), ...(map.value ? { map: map.value } : {}), permission: perm, ...extras.value };
  if (raw.source === 'snapshot') {
    if (typeof raw.section !== 'string' || !(SNAPSHOT_SECTIONS as readonly string[]).includes(raw.section)) {
      return fail(`data.section must be one of: ${SNAPSHOT_SECTIONS.join(', ')}`);
    }
    let also: string[] | undefined;
    if (raw.also !== undefined) {
      if (!Array.isArray(raw.also) || raw.also.length < 1 || raw.also.length > 6 || !raw.also.every(s => typeof s === 'string' && (SNAPSHOT_SECTIONS as readonly string[]).includes(s))) {
        return fail(`data.also must list up to 6 of: ${SNAPSHOT_SECTIONS.join(', ')}`);
      }
      also = Array.from(new Set(raw.also as string[])).filter(s => s !== raw.section);
    }
    if (raw.server !== undefined && typeof raw.server !== 'boolean') return fail('data.server must be true or false');
    return { ok: true, value: { source: 'snapshot', section: raw.section, ...(also?.length ? { also } : {}), ...(raw.server === true ? { server: true } : {}), ...base } };
  }
  if (raw.source === 'command' && raw.script !== undefined) {
    // Version 2: the data comes from a package script (run by the poller like an inline command).
    if (!v2) return fail('data.script needs spec version 2');
    if (typeof raw.script !== 'string' || !(raw.script in v2.scripts)) return fail('data.script must name one of the package scripts');
    const script = v2.scripts[raw.script];
    // The script's parameters get their values from the instance settings (`config.<key>`), never from a request.
    const args: Record<string, string> = {};
    if (raw.args !== undefined) {
      if (!isObj(raw.args)) return fail('data.args must map script parameters to instance settings');
      for (const [name, path] of Object.entries(raw.args)) {
        if (!(name in script.params)) return fail(`data.args: script "${raw.script}" has no parameter "${name}"`);
        if (typeof path !== 'string' || !path.startsWith('config.') || !FIELD_RE.test(path)) return fail(`data.args: "${name}" must be an instance setting such as "config.command"`);
        args[name] = path;
      }
    }
    for (const name of Object.keys(script.params)) {
      if (!(name in args)) return fail(`data.args: script "${raw.script}" needs the parameter "${name}": map it to an instance setting`);
    }
    if (!(PARSERS as readonly string[]).includes(String(raw.parse))) return fail(`data.parse must be one of: ${PARSERS.join(', ')}`);
    // A script may collect rarely (an update check runs every few hours) and take minutes.
    const cacheSec = intIn(raw.cacheSec, 5, 86400, 10);
    const timeoutSec = intIn(raw.timeoutSec, 1, 900, 20);
    const initialDelaySec = intIn(raw.initialDelaySec, 0, 3600, 0);
    if (cacheSec === null || timeoutSec === null || initialDelaySec === null) return fail('data.cacheSec must be 5-86400, data.timeoutSec 1-900 and data.initialDelaySec 0-3600');
    let cacheSecFrom: string | undefined;
    if (raw.cacheSecFrom !== undefined) {
      // The interval can be an instance setting (seconds), clamped to 5..cacheSec.
      if (typeof raw.cacheSecFrom !== 'string' || !raw.cacheSecFrom.startsWith('config.') || !FIELD_RE.test(raw.cacheSecFrom)) return fail('data.cacheSecFrom must be an instance setting such as "config.interval"');
      cacheSecFrom = raw.cacheSecFrom;
    }
    return {
      ok: true,
      value: {
        source: 'command', as: script.as, command: '', script: raw.script, ...(Object.keys(args).length ? { args } : {}), parse: raw.parse as (typeof PARSERS)[number],
        cacheSec, timeoutSec, ...(initialDelaySec ? { initialDelaySec } : {}), ...(cacheSecFrom ? { cacheSecFrom } : {}), ...base,
      },
    };
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

/** The declared parameters of an action. */
function actionParams(raw: Obj, where: string): Validated<Record<string, ParamSpec>> {
  const params: Record<string, ParamSpec> = {};
  if (raw.params !== undefined) {
    if (!isObj(raw.params) || Object.keys(raw.params).length > 10) return fail(`${where}: "params" must be an object of up to 10 parameters`);
    for (const [name, p] of Object.entries(raw.params)) {
      const v = validateParam(name, p, where);
      if (!v.ok) return v;
      params[name] = v.value;
    }
  }
  return { ok: true, value: params };
}

/** The parts every kind of action shares: when it is offered, its confirmation, what it shows afterwards. */
function actionTail(raw: Obj, where: string): Validated<Pick<ActionSpec, 'when' | 'confirm' | 'result' | 'after'>> {
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
    const requireText = raw.confirm.requireText === undefined ? undefined : text(raw.confirm.requireText, 100);
    if (requireText === null) return fail(`${where}: confirm.requireText must be short text`);
    confirm = { title, ...(body ? { text: body } : {}), destructive: raw.confirm.destructive === true, ...(requireText ? { requireText } : {}) };
  }
  const result = raw.result === undefined ? 'toast' : raw.result;
  if (result !== 'toast' && result !== 'text' && result !== 'none') return fail(`${where}: result must be toast, text or none`);
  const after = raw.after === undefined ? 'none' : raw.after;
  if (after !== 'refresh' && after !== 'none') return fail(`${where}: after must be refresh or none`);
  return { ok: true, value: { ...(when ? { when } : {}), ...(confirm ? { confirm } : {}), result, after } };
}

function validateAction(raw: unknown, ownPerms: ReadonlySet<string>, v2?: { scripts: Record<string, ScriptSpec> }): Validated<ActionSpec> {
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

  // A terminal action opens an interactive terminal that runs one command the package declares. The person types
  // their own login there and only Full access users get a web terminal at all; API keys get an API terminal when
  // they hold the action's permission and pass the action's check.
  if (raw.terminal !== undefined) {
    const t = raw.terminal;
    if (!isObj(t) || typeof t.ref !== 'string' || !FIELD_RE.test(t.ref)) return fail(`${where}: "terminal" needs "ref": the row field that names what to open a terminal in`);
    if (typeof t.refPattern !== 'string' || t.refPattern.length > 200 || !t.refPattern.startsWith('^') || !t.refPattern.endsWith('$')) return fail(`${where}: "terminal.refPattern" must be a regular expression anchored with ^ and $ (max 200 characters)`);
    try { new RegExp(t.refPattern); } catch { return fail(`${where}: "terminal.refPattern" is not a valid regular expression`); }
    if (typeof t.command !== 'string' || t.command.length < 1 || t.command.length > 500 || /[\u0000-\u001f]/.test(t.command)) return fail(`${where}: "terminal.command" must be one line of up to 500 characters`);
    if ((t.command.match(/\{\{ref\}\}/g) ?? []).length !== 1 || t.command.replace('{{ref}}', '').includes('{{')) return fail(`${where}: "terminal.command" must contain {{ref}} exactly once and no other placeholder`);
    let check: string | undefined;
    if (t.check !== undefined) {
      if (!v2) return fail(`${where}: "terminal.check" needs spec version 2`);
      if (typeof t.check !== 'string' || !(t.check in v2.scripts)) return fail(`${where}: "terminal.check" must name one of the package scripts`);
      if (!('ref' in v2.scripts[t.check].params)) return fail(`${where}: the check script "${t.check}" must declare a parameter named "ref"`);
      check = t.check;
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
        kind: 'terminal', terminal: { ref: t.ref, refPattern: t.refPattern, command: t.command, ...(check ? { check } : {}) }, as: 'service', command: '', params: {}, timeoutSec: 30,
        ...(when ? { when } : {}), result: 'none', after: 'none',
      },
    };
  }

  if (raw.kind === 'script') {
    // Version 2: runs the first variant whose condition holds (a script of the package, as the account it declares).
    if (!v2) return fail(`${where}: script actions need spec version 2`);
    // (An empty `command`, and `as`/`timeoutSec`, are what a stored script action carries; the script decides those.)
    if ((typeof raw.command === 'string' && raw.command !== '') || raw.windowsCommand !== undefined) return fail(`${where}: a script action has "variants" instead of a command`);
    const sparams = actionParams(raw, where);
    if (!sparams.ok) return sparams;
    const variants = validateVariants(raw.variants, where, v2.scripts, sparams.value);
    if (!variants.ok) return variants;
    const stail = actionTail(raw, where);
    if (!stail.ok) return stail;
    if (raw.job !== undefined && typeof raw.job !== 'boolean') return fail(`${where}: "job" must be true or false`);
    if (raw.stores !== undefined && raw.stores !== 'data') return fail(`${where}: "stores" must be "data" or left out`);
    return {
      ok: true,
      value: {
        id, label, ...(description ? { description } : {}), ...(raw.icon ? { icon: raw.icon as ActionSpec['icon'] } : {}), permission: raw.permission,
        kind: 'script', as: v2.scripts[variants.value[0].script].as, command: '', params: sparams.value, timeoutSec: 30,
        variants: variants.value, ...(raw.job === true ? { job: true } : {}), ...(raw.stores === 'data' ? { stores: 'data' as const } : {}), ...stail.value,
      },
    };
  }
  if (raw.kind !== undefined && raw.kind !== 'command') return fail(`${where}: "kind" must be "command", "script" or left out`);

  if (raw.as !== 'service' && raw.as !== 'shell') return fail(`${where}: "as" must be "service" (the privileged account) or "shell" (the non-admin account)`);

  const params = actionParams(raw, where);
  if (!params.ok) return params;
  const command = validateCommand(raw.command, params.value, where);
  if (!command.ok) return command;
  let windowsCommand: string | undefined;
  if (raw.windowsCommand !== undefined) {
    const w = validateCommand(raw.windowsCommand, params.value, `${where} windowsCommand`);
    if (!w.ok) return w;
    windowsCommand = w.value;
  }
  const timeoutSec = intIn(raw.timeoutSec, 1, 300, 30);
  if (timeoutSec === null) return fail(`${where}: timeoutSec must be 1-300`);
  const tail = actionTail(raw, where);
  if (!tail.ok) return tail;
  return {
    ok: true,
    value: {
      id, label, ...(description ? { description } : {}), ...(raw.icon ? { icon: raw.icon as ActionSpec['icon'] } : {}), permission: raw.permission, kind: 'command', as: raw.as,
      command: command.value, ...(windowsCommand ? { windowsCommand } : {}), params: params.value, timeoutSec, ...tail.value,
    },
  };
}

function validateFields(raw: unknown, where: string): Validated<FieldSpec[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 24) return fail(`${where} must be a list of 1-24 fields`);
  const out: FieldSpec[] = [];
  for (const f of raw as unknown[]) {
    if (!isObj(f)) return fail(`${where}: each field must be an object`);
    const label = text(f.label, 40);
    const value = text(f.value, 200);
    if (!label || !value) return fail(`${where}: each field needs a label and a value`);
    const format = f.format === undefined ? 'text' : f.format;
    if (!(FORMATS as readonly string[]).includes(String(format))) return fail(`${where}: format must be one of: ${FORMATS.join(', ')}`);
    const item: FieldSpec = { label, value, format: format as FieldSpec['format'] };
    if (f.bar !== undefined) {
      const bar = text(f.bar, 200);
      if (!bar) return fail(`${where}: "bar" must be a template that gives a number from 0 to 100`);
      item.bar = bar;
    }
    if (f.when !== undefined) {
      const c = cond(f.when, `${where} "when"`);
      if (!c.ok) return c;
      item.when = c.value;
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

function validateView(raw: unknown, actionIds: ReadonlySet<string>, v2 = false): Validated<ViewSpec> {
  if (!isObj(raw)) return fail('"view" is required');
  if (raw.type !== 'list' && raw.type !== 'table' && raw.type !== 'text' && raw.type !== 'fields' && raw.type !== 'chart' && raw.type !== 'layout') {
    return fail('view.type must be "list", "table", "fields", "chart", "layout" or "text"');
  }
  const view: ViewSpec = { type: raw.type };
  if (raw.type === 'layout') {
    if (!v2) return fail('layout views need spec version 2');
    const blocks = validateLayout(raw.blocks, actionIds, inner => validateView(inner, actionIds, true), validateFields);
    if (!blocks.ok) return blocks;
    view.blocks = blocks.value;
    return { ok: true, value: view };
  }
  if (raw.type === 'chart') {
    const c = raw.chart;
    if (!isObj(c) || !Array.isArray(c.metrics) || c.metrics.length < 1 || c.metrics.length > 6 || !c.metrics.every(m => typeof m === 'string' && /^[a-z0-9_.]{1,64}$/.test(m))) {
      return fail('a chart view needs chart.metrics: 1-6 metric names such as "cpu.usage"');
    }
    view.chart = { metrics: c.metrics as string[] };
    return { ok: true, value: view };
  }
  if (raw.type === 'fields') {
    const f = validateFields(raw.fields, 'view.fields');
    if (!f.ok) return f;
    view.fields = f.value;
    if (raw.empty !== undefined) { const e = text(raw.empty, 200); if (!e) return fail('view.empty must be text'); view.empty = e; }
    return { ok: true, value: view };
  }
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
    if (raw.row.fields !== undefined) {
      const f = validateFields(raw.row.fields, 'view.row.fields');
      if (!f.ok) return f;
      row.fields = f.value;
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
const METRIC_NAME_RE = /^[a-z][a-z0-9_*]{0,30}(\.[a-z0-9_*]{1,30}){1,3}$/;

function validateMetrics(raw: unknown, packageId: string | undefined): Validated<MetricSpec[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return fail('"metrics" must be a list of 1-20 statistics');
  const out: MetricSpec[] = [];
  const seen = new Set<string>();
  const limit = (v: unknown, name: string, max: number): Validated<number | undefined> => {
    if (v === undefined) return { ok: true, value: undefined };
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) return fail(`metric "${name}": retention must be a whole number from 1 to ${max}`);
    return { ok: true, value: v };
  };
  for (const m of raw as unknown[]) {
    if (!isObj(m)) return fail('each metric must be an object');
    const name = typeof m.name === 'string' ? m.name : '';
    if (!METRIC_NAME_RE.test(name)) return fail(`metric name "${name}" must look like "cpu.usage" or "mypkg.running" (lowercase, digits, underscores, dots; "*" only in a built-in metric name)`);
    if (seen.has(name)) return fail(`metric "${name}" is listed twice`);
    seen.add(name);
    const item: MetricSpec = { name };
    if (m.label !== undefined) { const l = text(m.label, 60); if (!l) return fail(`metric "${name}": label must be text`); item.label = l; }
    if (m.unit !== undefined) { const u = text(m.unit, 12); if (!u) return fail(`metric "${name}": unit must be short text`); item.unit = u; }
    const raw_ = limit(m.rawHours, name, 24 * 90); if (!raw_.ok) return raw_; if (raw_.value) item.rawHours = raw_.value;
    const d5 = limit(m.rollup5mDays, name, 365); if (!d5.ok) return d5; if (d5.value) item.rollup5mDays = d5.value;
    const d1 = limit(m.rollup1hDays, name, 3650); if (!d1.ok) return d1; if (d1.value) item.rollup1hDays = d1.value;
    if (m.from !== undefined) {
      if (!isObj(m.from)) return fail(`metric "${name}": "from" must be an object`);
      if (name.includes('*')) return fail(`metric "${name}": a metric computed from the data cannot use "*" in its name`);
      if (packageId && !name.startsWith(`${packageId}.`)) return fail(`metric "${name}": metrics computed from the data must start with "${packageId}."`);
      const agg = String(m.from.agg);
      if (!(METRIC_AGGS as readonly string[]).includes(agg)) return fail(`metric "${name}": from.agg must be one of: ${METRIC_AGGS.join(', ')}`);
      const field = m.from.field === undefined ? undefined : (typeof m.from.field === 'string' && FIELD_RE.test(m.from.field) ? m.from.field : null);
      if (field === null) return fail(`metric "${name}": from.field must be a field name`);
      if (agg !== 'count' && !field) return fail(`metric "${name}": "${agg}" needs from.field`);
      let where: Cond | undefined;
      if (m.from.where !== undefined) { const c = cond(m.from.where, `metric "${name}" "where"`); if (!c.ok) return c; where = c.value; }
      // The rows to aggregate: the widget's data, or the list at this dotted path inside it (version 2 data is often an object).
      const from = m.from.path === undefined ? undefined : (typeof m.from.path === 'string' && FIELD_RE.test(m.from.path) ? m.from.path : null);
      if (from === null) return fail(`metric "${name}": from.path must be a dotted path into the data`);
      item.from = { agg: agg as (typeof METRIC_AGGS)[number], ...(field ? { field } : {}), ...(from ? { path: from } : {}), ...(where ? { where } : {}) };
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

export function validateWidgetSpec(raw: unknown, ownPermissions: readonly string[], packageId?: string): Validated<WidgetSpec> {
  if (!isObj(raw)) return fail('"spec" must be an object');
  if (raw.version !== 1 && raw.version !== 2) return fail('spec.version must be 1 or 2');
  const v2on = raw.version === 2;
  if (!v2on) {
    for (const k of ['scripts', 'state', 'lookups'] as const) if (raw[k] !== undefined) return fail(`"${k}" needs spec version 2`);
  }
  const own = new Set(ownPermissions);
  const scripts = v2on ? validateScripts(raw.scripts) : { ok: true as const, value: {} as Record<string, ScriptSpec> };
  if (!scripts.ok) return scripts;
  const v2 = v2on ? { scripts: scripts.value } : undefined;
  const data = validateData(raw.data, own, v2);
  if (!data.ok) return data;
  const actions: ActionSpec[] = [];
  const ids = new Set<string>();
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || raw.actions.length > 20) return fail('"actions" must be a list of up to 20 actions');
    for (const a of raw.actions) {
      const v = validateAction(a, own, v2);
      if (!v.ok) return v;
      if (ids.has(v.value.id)) return fail(`action "${v.value.id}" is listed twice`);
      ids.add(v.value.id);
      actions.push(v.value);
    }
  }
  const view = validateView(raw.view, ids, v2on);
  if (!view.ok) return view;
  const state = v2on ? validateState(raw.state, scripts.value) : { ok: true as const, value: undefined };
  if (!state.ok) return state;
  const lookups = v2on ? validateLookups(raw.lookups) : { ok: true as const, value: {} as Record<string, LookupSpec> };
  if (!lookups.ok) return lookups;
  let metrics: MetricSpec[] | undefined;
  if (raw.metrics !== undefined) {
    const m = validateMetrics(raw.metrics, packageId);
    if (!m.ok) return m;
    metrics = m.value;
  }
  return {
    ok: true,
    value: {
      version: raw.version, data: data.value, view: view.value, actions, ...(metrics ? { metrics } : {}),
      ...(Object.keys(scripts.value).length ? { scripts: scripts.value } : {}),
      ...(state.value ? { state: state.value } : {}),
      ...(Object.keys(lookups.value).length ? { lookups: lookups.value } : {}),
    },
  };
}

/** Does a row satisfy a condition? Used by the view and, for toggles and summaries, the renderer. */
export function evalCond(c: Cond, row: unknown): boolean {
  if (c.all) return c.all.every(x => evalCond(x, row));
  if (c.any) return c.any.some(x => evalCond(x, row));
  if (c.not) return !evalCond(c.not, row);
  if (c.field === undefined) return false;
  const v = getPath(row, c.field);
  const num = Number(v);
  const isNum = v !== undefined && v !== null && v !== '' && Number.isFinite(num);
  if (c.gt !== undefined) return isNum && num > c.gt;
  if (c.gte !== undefined) return isNum && num >= c.gte;
  if (c.lt !== undefined) return isNum && num < c.lt;
  if (c.lte !== undefined) return isNum && num <= c.lte;
  if (c.newerThan !== undefined) return isNewerVersion(v, getPath(row, c.newerThan));
  if (c.exists !== undefined) return (v !== undefined && v !== null && v !== '') === c.exists;
  if (c.equals !== undefined) return v === c.equals || (v !== undefined && v !== null && String(v) === String(c.equals));
  if (c.notEquals !== undefined) return !(v === c.notEquals || (v !== undefined && v !== null && String(v) === String(c.notEquals)));
  if (c.in !== undefined) return c.in.some(x => v === x || (v !== undefined && v !== null && String(v) === String(x)));
  return false;
}

/** Is `candidate` a newer x.y.z version than `current`? False when either has no version. */
export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  const parse = (v: unknown) => { const m = String(v ?? '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
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
    if (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null)) return v.join(', ');
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/**
 * The part of a spec the browser needs: how to draw the widget and which actions exist, but
 * not the commands that implement them.
 */
export function publicSpec(spec: WidgetSpec): Omit<WidgetSpec, 'data' | 'actions' | 'scripts' | 'state' | 'lookups'> & {
  data: { source: DataSpec['source'] };
  actions: (Omit<ActionSpec, 'command' | 'windowsCommand' | 'as' | 'timeoutSec' | 'variants' | 'terminal'> & { variants?: { when?: Cond }[]; terminal?: { ref: string } })[];
} {
  // Scripts, the state probe, lookups and the arguments of script variants are never sent to the browser; it only
  // gets what it needs to draw the widget and to decide which actions to offer (a variant's condition).
  return {
    version: spec.version,
    view: spec.view,
    data: { source: spec.data.source },
    actions: spec.actions.map(a => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { command, windowsCommand, as, timeoutSec, variants, terminal, ...rest } = a;
      return { ...rest, ...(variants ? { variants: variants.map(v => (v.when ? { when: v.when } : {})) } : {}), ...(terminal ? { terminal: { ref: terminal.ref } } : {}) };
    }),
  };
}
