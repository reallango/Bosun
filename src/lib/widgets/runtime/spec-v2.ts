/**
 * Widget spec version 2: what a package can add on top of version 1 so that a whole widget, with its own logic and
 * screens, lives in its package and nothing about it is built into Bosun.
 *
 *  - `scripts`   host scripts shipped in the package (one file per platform), run as a declared account with
 *                declared, strictly typed parameters (passed as data, never pasted into the script text)
 *  - `state`     a probe script the poller runs on the host now and then; its `key=value` output is the widget's state
 *  - `lookups`   HTTP GETs of fixed https URLs (hosts declared in the manifest) whose result is a single value
 *  - actions     of kind `script`: variants chosen by conditions, optionally a long-running job
 *  - view        `layout`: sections (collapsible, with badges), key/value lists, notices, buttons, forms, selects and
 *                job progress around the usual list/table/fields/chart/text views
 *
 * Nothing here runs package code inside Bosun or the browser: everything a package does to a host is one of its
 * reviewed scripts. Pure (no I/O).
 */
import type { ActionSpec, Cond, FieldSpec, ParamSpec, RunAs, ViewSpec } from './spec';
import { cond, fail, FIELD_RE, ID_RE, intIn, isObj, PARAM_RE, text, validateParam, type Obj, type Validated } from './spec-util';

export const SCRIPT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const MAX_SCRIPTS = 40;
export const MAX_BLOCKS = 60;
const MAX_BLOCK_DEPTH = 5;
const BADGE_COLORS = ['green', 'amber', 'red', 'gray', 'blue'] as const;
const LITERAL_RE = /^[A-Za-z0-9_.:/ -]{0,100}$/;
const STATE_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const IPV4_RE = /^[0-9]+(\.[0-9]+){3}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ScriptSpec {
  as: RunAs;
  timeoutSec: number;
  /** Package file per platform (`linux` ends in .sh, `windows` in .ps1); a script need not exist on both. */
  linux?: string;
  windows?: string;
  params: Record<string, ParamSpec>;
  /** Secrets of the package (declared in its manifest) this script receives as BOSUN_SECRET_<id> (Linux hosts only). */
  secrets?: string[];
}

export type StateFieldType = 'string' | 'number' | 'boolean';

export interface StateSpec {
  /** A key of `scripts`. */
  script: string;
  periodSec: number;
  initialDelaySec: number;
  fields: Record<string, StateFieldType>;
}

export interface LookupSpec {
  url: string;
  /** Dotted path into the JSON answer. */
  path: string;
  /** Optional regular expression with one capture group applied to the value (for example the x.y.z of a tag). */
  match?: string;
  ttlSec: number;
}

export interface ActionVariant {
  when?: Cond;
  script: string;
  /** Script parameter -> where its value comes from: `param.<action parameter>` or a path into the context. */
  args: Record<string, string>;
}

export interface Badge { text: string; color: (typeof BADGE_COLORS)[number]; when?: Cond }

export interface FormField {
  name: string;
  label: string;
  input: 'number' | 'text' | 'select';
  /** Path into the context holding the current value. */
  value?: string;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export const EDITOR_INPUTS = ['text', 'number', 'select', 'checkbox', 'textarea', 'lines', 'pairs', 'rows', 'button', 'heading'] as const;

/** One column of a `rows` field: a labelled box (text, number or a drop-down). */
export interface RowColumn {
  name: string;
  label: string;
  input: 'text' | 'number' | 'select';
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** The value of a new row, and of a stored line that lacks this column. */
  default?: string;
  /** Suggestions for a text column from a list in the context (a datalist): `path` to the list, `value` the field of each item. */
  suggest?: { path: string; value: string };
  /** A select column whose options are the ones the row field's `remote` found (the services of a compose file). */
  remote?: boolean;
}

/**
 * How the columns of a row become one line of the settings blob (`format`) and back (`parse`, a regular expression with a named
 * group per column). A part is left out when its column is empty and `optional`, or when the value is one of `omit`.
 * `derive` fills a column from another one after parsing (a folder when the source starts with "/", otherwise a volume).
 */
export interface RowFormatPart { col?: string; /** Fixed text written as it is (no column). */ lit?: string; prefix?: string; suffix?: string; optional?: boolean; omit?: string[] }
export interface RowDerive { from: string; startsWith: string; then: string; else: string }

/** Options fetched from the host while the form is open (the branches of a repository): a dataset called with arguments from the form. */
export interface RemoteOptions {
  dataset: string;
  /** Dataset parameter -> `values.<field>`, `context.<path>` or `literal:<text>`. The options load once every `values.` argument has a value. */
  args: Record<string, string>;
  /** Path to the list in the dataset's answer, and the fields of each item (a string item needs no `value`). */
  path: string;
  value?: string;
  label?: string;
}

/**
 * One field of an `editor` block. Its value goes into the settings blob (see serializeEditor) under `key` (default: the name):
 * text, number and select as `key=value`, a checkbox as `key=true|false`, a text area as one `key=line` per line, `lines` and
 * `pairs` (rows of a value, or of name and value) as one `key=row` per row. `warn` is shown when the field is used (risky options).
 */
export interface EditorField {
  name: string;
  label: string;
  input: (typeof EDITOR_INPUTS)[number];
  key?: string;
  /** Path into the screen's context holding the starting value (a string, number, boolean or list of strings). */
  value?: string;
  placeholder?: string;
  help?: string;
  warn?: string;
  options?: { value: string; label: string }[];
  /** Options built from a list in the context (for example the networks dataset): `path` to the list, `value` and `label` fields of each item. */
  optionsFrom?: { path: string; value?: string; label?: string };
  required?: boolean;
  /** Shown only while this holds; it reads the current form values as `values.<name>`. */
  when?: Cond;
  /** Text area: its height in lines (default 6), and whether a file can be loaded into it. */
  height?: number;
  upload?: boolean;
  /** Not part of the settings: a box used by a button (text to convert) or by the person only. */
  transient?: boolean;
  /** Heading: the fields up to the next heading are hidden until the person opens it. */
  collapsed?: boolean;
  /** `pairs` or `textarea` of KEY=value lines: values of names that look secret (password, token ...) are masked on screen, kept out of logs, and saved encrypted so a screen can be reopened without typing them again. */
  mask?: 'secret-names';
  /** Select: also offer "Custom", which shows a box to type a value (and is chosen when the host finds no options). */
  custom?: string;
  remote?: RemoteOptions;
  /** Rows: the columns and how a row is written to and read from a line of the settings. */
  columns?: RowColumn[];
  format?: RowFormatPart[];
  parse?: string;
  derive?: Record<string, RowDerive>;
  /** Button: asks the host to fill fields. The dataset answers { fill: { <field key>: value }, errors?: [], notes?: [] }. */
  tool?: { dataset: string; args: Record<string, string>; busy?: string };
}

export interface EditorSubmit {
  action: string;
  label: string;
  style: 'primary' | 'danger';
  /** Action parameter -> where its value comes from: `values.<field>`, a path into the screen's context (`context.name`) or `literal:<text>`. */
  params: Record<string, string>;
}

export type Block =
  | { type: 'code'; title?: string; value: string; filename?: string; when?: Cond }
  | { type: 'tabs'; tabs: { id: string; label: string; blocks: Block[] }[]; when?: Cond }
  | { type: 'editor'; fields: EditorField[]; /** The text parameter of the submit actions that receives the settings blob (none: the fields are mapped one by one in each submit's params). */ param?: string; submits: EditorSubmit[]; when?: Cond }
  | { type: 'section'; title: string; defaultOpen: boolean; badges: Badge[]; summary?: string; blocks: Block[]; when?: Cond }
  | { type: 'kv'; items: FieldSpec[]; when?: Cond }
  | { type: 'text'; text: string; when?: Cond }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; when?: Cond }
  | { type: 'buttons'; actions: string[]; when?: Cond }
  | { type: 'form'; title?: string; fields: FormField[]; submit: { action: string; label: string; params: Record<string, string> }; when?: Cond }
  | { type: 'select'; label: string; value: string; options: { value: string; label: string }[]; action: string; param: string; when?: Cond }
  | { type: 'jobProgress'; when?: Cond }
  /** `path`: the part of the widget's data the inner view shows (default: all of it). */
  | { type: 'view'; view: ViewSpec; path?: string; when?: Cond };

/** What the validators of version 1 give version 2 to work with. */
export interface V2Context {
  scripts: Record<string, ScriptSpec>;
}

// ---- scripts, state, lookups ---------------------------------------------------------------------------------

export function validateScripts(raw: unknown): Validated<Record<string, ScriptSpec>> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isObj(raw)) return fail('"scripts" must be an object of script definitions');
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCRIPTS) return fail(`"scripts" may define at most ${MAX_SCRIPTS} scripts`);
  const out: Record<string, ScriptSpec> = {};
  for (const [id, s] of entries) {
    const where = `script "${id}"`;
    if (!ID_RE.test(id)) return fail(`${where}: ids are lowercase letters, digits and underscores`);
    if (!isObj(s)) return fail(`${where} must be an object`);
    if (s.as !== 'service' && s.as !== 'shell') return fail(`${where}: "as" must be "service" (the privileged account) or "shell" (the non-admin account)`);
    const timeoutSec = intIn(s.timeoutSec, 1, 3600, 60);
    if (timeoutSec === null) return fail(`${where}: timeoutSec must be 1-3600`);
    const files: { linux?: string; windows?: string } = {};
    for (const [platform, ext] of [['linux', '.sh'], ['windows', '.ps1']] as const) {
      const f = (s as Obj)[platform];
      if (f === undefined) continue;
      if (typeof f !== 'string' || f.length > 120 || !SCRIPT_FILE_RE.test(f) || f.split('/').some(p => p === '.' || p === '..') || !f.endsWith(ext)) {
        return fail(`${where}: "${platform}" must be a file of the package ending in ${ext}`);
      }
      files[platform] = f;
    }
    if (!files.linux && !files.windows) return fail(`${where}: give a "linux" and/or a "windows" file`);
    const params: Record<string, ParamSpec> = {};
    if (s.params !== undefined) {
      if (!isObj(s.params) || Object.keys(s.params).length > 12) return fail(`${where}: "params" must be an object of up to 12 parameters`);
      for (const [name, p] of Object.entries(s.params)) {
        const v = validateParam(name, p, where);
        if (!v.ok) return v;
        params[name] = v.value;
      }
    }
    let secrets: string[] | undefined;
    if (s.secrets !== undefined) {
      if (!Array.isArray(s.secrets) || s.secrets.length < 1 || s.secrets.length > 4 || !s.secrets.every(x => typeof x === 'string' && /^[a-z][a-z0-9_]{0,29}$/.test(x))) {
        return fail(`${where}: "secrets" must list up to 4 secret ids of the package`);
      }
      if (files.windows) return fail(`${where}: a script that uses secrets cannot have a Windows file (secrets are not available there)`);
      secrets = s.secrets as string[];
    }
    out[id] = { as: s.as, timeoutSec, ...files, params, ...(secrets ? { secrets } : {}) };
  }
  return { ok: true, value: out };
}

export function validateState(raw: unknown, scripts: Record<string, ScriptSpec>): Validated<StateSpec | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail('"state" must be an object');
  if (typeof raw.script !== 'string' || !(raw.script in scripts)) return fail('state.script must name one of the package scripts');
  const script = scripts[raw.script];
  if (Object.keys(script.params).length > 0) return fail('state.script must be a script without parameters');
  const periodSec = intIn(raw.periodSec, 30, 86400, 60);
  const initialDelaySec = intIn(raw.initialDelaySec, 0, 3600, 0);
  if (periodSec === null || initialDelaySec === null) return fail('state.periodSec must be 30-86400 and state.initialDelaySec 0-3600');
  const fields: Record<string, StateFieldType> = {};
  if (raw.fields !== undefined) {
    if (!isObj(raw.fields) || Object.keys(raw.fields).length > 40) return fail('state.fields must be an object of up to 40 fields');
    for (const [k, t] of Object.entries(raw.fields)) {
      if (!STATE_KEY_RE.test(k) || k.length > 60) return fail(`state field "${k}": names are lowercase letters, digits, underscores and dots`);
      if (t !== 'string' && t !== 'number' && t !== 'boolean') return fail(`state field "${k}": type must be string, number or boolean`);
      fields[k] = t;
    }
  }
  return { ok: true, value: { script: raw.script, periodSec, initialDelaySec, fields } };
}

export function validateLookups(raw: unknown): Validated<Record<string, LookupSpec>> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isObj(raw)) return fail('"lookups" must be an object');
  const entries = Object.entries(raw);
  if (entries.length > 8) return fail('"lookups" may define at most 8 lookups');
  const out: Record<string, LookupSpec> = {};
  for (const [id, l] of entries) {
    const where = `lookup "${id}"`;
    if (!ID_RE.test(id)) return fail(`${where}: ids are lowercase letters, digits and underscores`);
    if (!isObj(l)) return fail(`${where} must be an object`);
    if (typeof l.url !== 'string' || l.url.length > 300) return fail(`${where}: "url" is required`);
    let u: URL;
    try { u = new URL(l.url); } catch { return fail(`${where}: "url" is not a valid URL`); }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !HOST_RE.test(u.hostname) || IPV4_RE.test(u.hostname)) {
      return fail(`${where}: "url" must be a plain https URL on a host name (no credentials, port or fragment)`);
    }
    if (typeof l.path !== 'string' || !FIELD_RE.test(l.path)) return fail(`${where}: "path" must be a dotted path into the JSON answer`);
    let match: string | undefined;
    if (l.match !== undefined) {
      if (typeof l.match !== 'string' || l.match.length > 200) return fail(`${where}: "match" must be a regular expression (max 200 characters)`);
      let groups: number;
      // Appending an alternative that matches the empty string makes exec('') succeed, so its length counts the groups.
      try { groups = (new RegExp(`${l.match}|`).exec('') ?? []).length - 1; } catch { return fail(`${where}: "match" is not a valid regular expression`); }
      if (groups !== 1) return fail(`${where}: "match" needs exactly one capture group`);
      match = l.match;
    }
    const ttlSec = intIn(l.ttlSec, 300, 86400, 3600);
    if (ttlSec === null) return fail(`${where}: ttlSec must be 300-86400`);
    out[id] = { url: l.url, path: l.path, ...(match ? { match } : {}), ttlSec };
  }
  return { ok: true, value: out };
}

/** The host names a spec's lookups contact (for the manifest check and the install review). */
export function lookupHosts(lookups: Record<string, LookupSpec> | undefined): string[] {
  return Array.from(new Set(Object.values(lookups ?? {}).map(l => new URL(l.url).hostname)));
}

// ---- script actions ------------------------------------------------------------------------------------------

/**
 * The variants of a `script` action: the first whose `when` holds is the one that runs. Every parameter of the
 * chosen script must be given, either by `args` or by an action parameter of the same name.
 */
export function validateVariants(
  raw: unknown, where: string, scripts: Record<string, ScriptSpec>, actionParams: Record<string, ParamSpec>,
): Validated<ActionVariant[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return fail(`${where}: "variants" must list 1-8 variants`);
  const out: ActionVariant[] = [];
  for (const v of raw as unknown[]) {
    if (!isObj(v)) return fail(`${where}: each variant must be an object`);
    if (typeof v.script !== 'string' || !(v.script in scripts)) return fail(`${where}: a variant must name one of the package scripts`);
    const script = scripts[v.script];
    let when: Cond | undefined;
    if (v.when !== undefined) { const c = cond(v.when, `${where} variant "when"`); if (!c.ok) return c; when = c.value; }
    const args: Record<string, string> = {};
    if (v.args !== undefined) {
      if (!isObj(v.args)) return fail(`${where}: "args" must map script parameters to paths`);
      for (const [name, path] of Object.entries(v.args)) {
        if (!(name in script.params)) return fail(`${where}: script "${v.script}" has no parameter "${name}"`);
        // A path into the context, or a fixed text written as "literal:<text>" (for a script that serves several settings).
        const isLiteral = typeof path === 'string' && path.startsWith('literal:') && LITERAL_RE.test(path.slice(8));
        if (typeof path !== 'string' || (!isLiteral && !FIELD_RE.test(path))) return fail(`${where}: argument "${name}" must be a path such as "state.install.name" or "param.value", or "literal:<text>"`);
        if (path.startsWith('param.') && !(path.slice(6) in actionParams)) return fail(`${where}: argument "${name}" refers to the action parameter "${path.slice(6)}", which is not declared`);
        args[name] = path;
      }
    }
    for (const [name, p] of Object.entries(script.params)) {
      // A parameter with a default of its own need not be mapped: the default is used.
      if (!(name in args) && !(name in actionParams) && p.default === undefined) return fail(`${where}: script "${v.script}" needs the parameter "${name}": map it in "args" or declare an action parameter with that name`);
    }
    out.push({ ...(when ? { when } : {}), script: v.script, args });
  }
  return { ok: true, value: out };
}

// ---- layout view ---------------------------------------------------------------------------------------------

type ViewValidator = (raw: unknown) => Validated<ViewSpec>;

function whenOf(raw: Obj, where: string): Validated<Cond | undefined> {
  if (raw.when === undefined) return { ok: true, value: undefined };
  const c = cond(raw.when, `${where} "when"`);
  return c.ok ? { ok: true, value: c.value } : c;
}

function options(raw: unknown, where: string, max = 20): Validated<{ value: string; label: string }[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return fail(`${where}: "options" must list 1-${max} options`);
  const out: { value: string; label: string }[] = [];
  for (const o of raw as unknown[]) {
    if (!isObj(o) || typeof o.value !== 'string' || o.value.length > 60) return fail(`${where}: each option needs a short "value"`);
    const label = text(o.label, 60);
    if (!label) return fail(`${where}: each option needs a label`);
    out.push({ value: o.value, label });
  }
  return { ok: true, value: out };
}

function validateEditorFields(raw: unknown, where: string): Validated<EditorField[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 120) return fail(`${where}: "fields" must list 1-120 fields`);
  const out: EditorField[] = [];
  for (const f of raw as unknown[]) {
    if (!isObj(f) || typeof f.name !== 'string' || !ID_RE.test(f.name)) return fail(`${where}: each field needs a "name" (lowercase letters, digits, underscores)`);
    if (out.some(x => x.name === f.name)) return fail(`${where}: the field "${f.name}" is listed twice`);
    const label = text(f.label, 80);
    if (!label || !(EDITOR_INPUTS as readonly string[]).includes(String(f.input))) return fail(`${where}: field "${f.name}" needs a label and an input (${EDITOR_INPUTS.join(', ')})`);
    const field: EditorField = { name: f.name, label, input: f.input as EditorField['input'] };
    if (f.key !== undefined) {
      if (typeof f.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) return fail(`${where}: field "${f.name}": "key" must be lowercase letters, digits and underscores`);
      field.key = f.key;
    }
    if (f.value !== undefined) {
      if (typeof f.value !== 'string' || !FIELD_RE.test(f.value)) return fail(`${where}: field "${f.name}": "value" must be a path into the context`);
      field.value = f.value;
    }
    for (const k of ['placeholder', 'help', 'warn'] as const) {
      if (f[k] === undefined) continue;
      const t = text(f[k], k === 'placeholder' ? 80 : 300);
      if (!t) return fail(`${where}: field "${f.name}": "${k}" must be short text`);
      field[k] = t;
    }
    if (f.input === 'select') {
      if (f.options !== undefined) { const o = options(f.options, `${where} field "${f.name}"`, 100); if (!o.ok) return o; field.options = o.value; }
      if (f.optionsFrom !== undefined) {
        const of = f.optionsFrom;
        if (!isObj(of) || typeof of.path !== 'string' || !FIELD_RE.test(of.path) || (of.value !== undefined && (typeof of.value !== 'string' || !FIELD_RE.test(of.value))) || (of.label !== undefined && (typeof of.label !== 'string' || !FIELD_RE.test(of.label)))) {
          return fail(`${where}: field "${f.name}": "optionsFrom" needs "path" (the list) and optionally "value" and "label" (fields of each item; a list of strings needs neither)`);
        }
        field.optionsFrom = { path: of.path, ...(of.value ? { value: of.value } : {}), ...(of.label ? { label: of.label } : {}) };
      }
      if (!field.options && !field.optionsFrom) return fail(`${where}: select field "${f.name}" needs "options" or "optionsFrom"`);
    }
    const ref = (s: unknown) => typeof s === 'string' && (s.startsWith('literal:') ? /^[A-Za-z0-9_.:/ -]{0,100}$/.test(s.slice(8)) : FIELD_RE.test(s));
    const refs = (a: unknown): Record<string, string> | null => {
      if (!isObj(a) || Object.keys(a).length > 8) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) { if (!PARAM_RE.test(k) || !ref(v)) return null; out[k] = v as string; }
      return out;
    };
    if (f.height !== undefined) {
      if (f.input !== 'textarea' || typeof f.height !== 'number' || !Number.isInteger(f.height) || f.height < 3 || f.height > 80) return fail(`${where}: field "${f.name}": "height" (3-80 lines) is for text areas`);
      field.height = f.height;
    }
    if (f.mask !== undefined) {
      if (f.mask !== 'secret-names' || (f.input !== 'pairs' && f.input !== 'textarea')) return fail(`${where}: field "${f.name}": "mask" is "secret-names", for pairs and text areas`);
      field.mask = 'secret-names';
    }
    for (const k of ['upload', 'transient', 'collapsed'] as const) {
      if (f[k] === undefined) continue;
      if (typeof f[k] !== 'boolean' || (k === 'upload' && f.input !== 'textarea') || (k === 'collapsed' && f.input !== 'heading')) return fail(`${where}: field "${f.name}": "${k}" is not allowed here`);
      field[k] = f[k] as boolean;
    }
    if (f.input === 'select' || f.input === 'rows') {
      if (f.input === 'select' && f.custom !== undefined) { const c = text(f.custom, 40); if (!c) return fail(`${where}: field "${f.name}": "custom" must be a short label`); field.custom = c; }
      if (f.remote !== undefined) {
        const r = f.remote;
        const args = isObj(r) ? refs(r.args ?? {}) : null;
        if (!isObj(r) || typeof r.dataset !== 'string' || !ID_RE.test(r.dataset) || !args || typeof r.path !== 'string' || !FIELD_RE.test(r.path)
          || (r.value !== undefined && (typeof r.value !== 'string' || !FIELD_RE.test(r.value))) || (r.label !== undefined && (typeof r.label !== 'string' || !FIELD_RE.test(r.label)))) {
          return fail(`${where}: field "${f.name}": "remote" needs "dataset", "args" (${'values.<field>'} or literals), "path" and optionally "value" and "label"`);
        }
        field.remote = { dataset: r.dataset, args, path: r.path, ...(r.value ? { value: r.value } : {}), ...(r.label ? { label: r.label } : {}) };
      }
    }
    if (f.input === 'button') {
      const t = f.tool;
      const args = isObj(t) ? refs(t.args ?? {}) : null;
      if (!isObj(t) || typeof t.dataset !== 'string' || !ID_RE.test(t.dataset) || !args) return fail(`${where}: button "${f.name}" needs "tool": { "dataset", "args" }`);
      const busy = t.busy === undefined ? undefined : text(t.busy, 60);
      if (busy === null) return fail(`${where}: button "${f.name}": "tool.busy" must be short text`);
      field.tool = { dataset: t.dataset, args, ...(busy ? { busy } : {}) };
    }
    if (f.input === 'rows') {
      if (!Array.isArray(f.columns) || f.columns.length < 2 || f.columns.length > 6) return fail(`${where}: rows field "${f.name}" needs 2-6 "columns"`);
      const cols: RowColumn[] = [];
      for (const c of f.columns as unknown[]) {
        if (!isObj(c) || typeof c.name !== 'string' || !ID_RE.test(c.name) || cols.some(x => x.name === c.name)) return fail(`${where}: rows field "${f.name}": each column needs a unique "name"`);
        const clabel = text(c.label, 40);
        if (!clabel || (c.input !== 'text' && c.input !== 'number' && c.input !== 'select')) return fail(`${where}: rows field "${f.name}": column "${c.name}" needs a label and an input (text, number or select)`);
        const col: RowColumn = { name: c.name, label: clabel, input: c.input };
        if (c.remote !== undefined) { if (c.remote !== true || c.input !== 'select') return fail(`${where}: column "${c.name}": "remote" is true, for a select column`); col.remote = true; }
        if (c.placeholder !== undefined) { const p = text(c.placeholder, 40); if (!p) return fail(`${where}: column "${c.name}": "placeholder" must be short text`); col.placeholder = p; }
        if (c.default !== undefined) { if (typeof c.default !== 'string' || c.default.length > 60) return fail(`${where}: column "${c.name}": "default" must be short text`); col.default = c.default; }
        if (c.input === 'select' && !col.remote) { const o = options(c.options, `${where} column "${c.name}"`, 30); if (!o.ok) return o; col.options = o.value; }
        if (c.suggest !== undefined) {
          if (!isObj(c.suggest) || typeof c.suggest.path !== 'string' || !FIELD_RE.test(c.suggest.path) || typeof c.suggest.value !== 'string' || !FIELD_RE.test(c.suggest.value)) return fail(`${where}: column "${c.name}": "suggest" needs "path" and "value"`);
          col.suggest = { path: c.suggest.path, value: c.suggest.value };
        }
        cols.push(col);
      }
      field.columns = cols;
      const names = new Set(cols.map(c => c.name));
      if (!Array.isArray(f.format) || f.format.length < 1 || f.format.length > 8) return fail(`${where}: rows field "${f.name}" needs a "format" (1-8 parts)`);
      const fmt: RowFormatPart[] = [];
      for (const p of f.format as unknown[]) {
        if (isObj(p) && p.lit !== undefined) {
          if (typeof p.lit !== 'string' || p.lit.length < 1 || p.lit.length > 16 || /[\u0000-\u001f]/.test(p.lit)) return fail(`${where}: rows field "${f.name}": "lit" is 1-16 characters of fixed text`);
          fmt.push({ lit: p.lit });
          continue;
        }
        if (!isObj(p) || typeof p.col !== 'string' || !names.has(p.col)) return fail(`${where}: rows field "${f.name}": every format part names a column`);
        const part: RowFormatPart = { col: p.col };
        for (const k of ['prefix', 'suffix'] as const) {
          if (p[k] === undefined) continue;
          if (typeof p[k] !== 'string' || (p[k] as string).length > 4 || /[\u0000-\u001f]/.test(p[k] as string)) return fail(`${where}: rows field "${f.name}": "${k}" is up to 4 characters`);
          part[k] = p[k] as string;
        }
        if (p.optional !== undefined) { if (typeof p.optional !== 'boolean') return fail(`${where}: rows field "${f.name}": "optional" is true or false`); part.optional = p.optional; }
        if (p.omit !== undefined) { if (!Array.isArray(p.omit) || p.omit.length > 5 || !p.omit.every(x => typeof x === 'string' && x.length <= 40)) return fail(`${where}: rows field "${f.name}": "omit" lists up to 5 values`); part.omit = p.omit as string[]; }
        fmt.push(part);
      }
      field.format = fmt;
      if (typeof f.parse !== 'string' || f.parse.length > 300 || !f.parse.startsWith('^') || !f.parse.endsWith('$')) return fail(`${where}: rows field "${f.name}": "parse" must be a regular expression anchored with ^ and $ (max 300 characters)`);
      let re: RegExp;
      try { re = new RegExp(f.parse); } catch { return fail(`${where}: rows field "${f.name}": "parse" is not a valid regular expression`); }
      const groups = Array.from(f.parse.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)).map(m => m[1]);
      if (!groups.length || !groups.every(g => names.has(g))) return fail(`${where}: rows field "${f.name}": the named groups of "parse" must be columns`);
      void re;
      field.parse = f.parse;
      if (f.derive !== undefined) {
        if (!isObj(f.derive) || Object.keys(f.derive).length > 3) return fail(`${where}: rows field "${f.name}": "derive" is an object of up to 3 columns`);
        const d: Record<string, RowDerive> = {};
        for (const [col, rule] of Object.entries(f.derive)) {
          if (!names.has(col) || !isObj(rule) || typeof rule.from !== 'string' || !names.has(rule.from) || typeof rule.startsWith !== 'string' || rule.startsWith.length > 4
            || typeof rule.then !== 'string' || typeof rule.else !== 'string') return fail(`${where}: rows field "${f.name}": "derive.${col}" needs from, startsWith, then and else`);
          d[col] = { from: rule.from, startsWith: rule.startsWith, then: rule.then, else: rule.else };
        }
        field.derive = d;
      }
    }
    if (f.required !== undefined) { if (typeof f.required !== 'boolean') return fail(`${where}: field "${f.name}": "required" must be true or false`); field.required = f.required; }
    if (f.when !== undefined) { const c = cond(f.when, `${where} field "${f.name}" "when"`); if (!c.ok) return c; field.when = c.value; }
    out.push(field);
  }
  return { ok: true, value: out };
}

export function validateLayout(
  rawBlocks: unknown, actionIds: ReadonlySet<string>, innerView: ViewValidator, validateFields: (raw: unknown, where: string) => Validated<FieldSpec[]>,
): Validated<Block[]> {
  let count = 0;
  const walk = (raw: unknown, depth: number, where: string): Validated<Block[]> => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) return fail(`${where}: "blocks" must list 1-30 blocks`);
    if (depth > MAX_BLOCK_DEPTH) return fail(`${where}: blocks are nested too deeply`);
    const out: Block[] = [];
    for (const b of raw as unknown[]) {
      if (++count > MAX_BLOCKS) return fail(`a layout may have at most ${MAX_BLOCKS} blocks`);
      if (!isObj(b) || typeof b.type !== 'string') return fail(`${where}: each block needs a "type"`);
      const w = `${where} ${b.type} block`;
      const when = whenOf(b, w);
      if (!when.ok) return when;
      const base = when.value ? { when: when.value } : {};
      const actionRef = (id: unknown): string | null => (typeof id === "string" && actionIds.has(id) ? id : null);
      switch (b.type) {
        case 'section': {
          const title = text(b.title, 80);
          if (!title) return fail(`${w}: a title is required`);
          const badges: Badge[] = [];
          if (b.badges !== undefined) {
            if (!Array.isArray(b.badges) || b.badges.length > 4) return fail(`${w}: "badges" must list up to 4 badges`);
            for (const x of b.badges as unknown[]) {
              if (!isObj(x)) return fail(`${w}: each badge must be an object`);
              const t = text(x.text, 40);
              if (!t || !(BADGE_COLORS as readonly string[]).includes(String(x.color))) return fail(`${w}: each badge needs text and a color (${BADGE_COLORS.join(', ')})`);
              const bw = whenOf(x, `${w} badge`);
              if (!bw.ok) return bw;
              badges.push({ text: t, color: x.color as Badge['color'], ...(bw.value ? { when: bw.value } : {}) });
            }
          }
          const summary = b.summary === undefined ? undefined : text(b.summary, 200);
          if (summary === null) return fail(`${w}: "summary" must be text`);
          const inner = walk(b.blocks, depth + 1, w);
          if (!inner.ok) return inner;
          out.push({ type: 'section', title, defaultOpen: b.defaultOpen === true, badges, ...(summary ? { summary } : {}), blocks: inner.value, ...base });
          break;
        }
        case 'kv': {
          const items = validateFields(b.items, `${w} items`);
          if (!items.ok) return items;
          out.push({ type: 'kv', items: items.value, ...base });
          break;
        }
        case 'text': {
          const t = text(b.text, 1000);
          if (!t) return fail(`${w}: "text" is required`);
          out.push({ type: 'text', text: t, ...base });
          break;
        }
        case 'notice': {
          const t = text(b.text, 400);
          if (!t || (b.level !== 'info' && b.level !== 'warning' && b.level !== 'error')) return fail(`${w}: needs "level" (info, warning or error) and "text"`);
          out.push({ type: 'notice', level: b.level, text: t, ...base });
          break;
        }
        case 'buttons': {
          if (!Array.isArray(b.actions) || b.actions.length < 1 || b.actions.length > 10 || !b.actions.every(a => actionRef(a) !== null)) {
            return fail(`${w}: "actions" must list ids of actions this widget declares`);
          }
          out.push({ type: 'buttons', actions: b.actions as string[], ...base });
          break;
        }
        case 'form': {
          if (!Array.isArray(b.fields) || b.fields.length < 1 || b.fields.length > 8) return fail(`${w}: "fields" must list 1-8 fields`);
          const fields: FormField[] = [];
          for (const f of b.fields as unknown[]) {
            if (!isObj(f) || typeof f.name !== 'string' || !ID_RE.test(f.name)) return fail(`${w}: each field needs a "name" (lowercase letters, digits, underscores)`);
            const label = text(f.label, 60);
            if (!label || (f.input !== 'number' && f.input !== 'text' && f.input !== 'select')) return fail(`${w}: field "${f.name}" needs a label and an input (number, text or select)`);
            if (f.value !== undefined && (typeof f.value !== 'string' || !FIELD_RE.test(f.value))) return fail(`${w}: field "${f.name}": "value" must be a path into the context`);
            const placeholder = f.placeholder === undefined ? undefined : text(f.placeholder, 60);
            const help = f.help === undefined ? undefined : text(f.help, 300);
            if (placeholder === null || help === null) return fail(`${w}: field "${f.name}": placeholder and help must be text`);
            let opts: { value: string; label: string }[] | undefined;
            if (f.input === 'select') { const o = options(f.options, `${w} field "${f.name}"`); if (!o.ok) return o; opts = o.value; }
            fields.push({ name: f.name, label, input: f.input, ...(f.value ? { value: f.value as string } : {}), ...(placeholder ? { placeholder } : {}), ...(help ? { help } : {}), ...(opts ? { options: opts } : {}) });
          }
          if (!isObj(b.submit) || actionRef(b.submit.action) === null) return fail(`${w}: "submit.action" must be the id of an action this widget declares`);
          const label = text(b.submit.label, 40);
          if (!label) return fail(`${w}: "submit.label" is required`);
          const params: Record<string, string> = {};
          if (b.submit.params !== undefined) {
            if (!isObj(b.submit.params)) return fail(`${w}: "submit.params" must map action parameters to form fields`);
            for (const [p, field] of Object.entries(b.submit.params)) {
              if (typeof field !== 'string' || !fields.some(f => f.name === field)) return fail(`${w}: "submit.params.${p}" must name a field of this form`);
              params[p] = field;
            }
          }
          const title = b.title === undefined ? undefined : text(b.title, 80);
          if (title === null) return fail(`${w}: "title" must be text`);
          out.push({ type: 'form', ...(title ? { title } : {}), fields, submit: { action: b.submit.action as string, label, params }, ...base });
          break;
        }
        case 'select': {
          const label = text(b.label, 60);
          if (!label || typeof b.value !== 'string' || !FIELD_RE.test(b.value)) return fail(`${w}: needs a label and a "value" path into the context`);
          const o = options(b.options, w);
          if (!o.ok) return o;
          if (actionRef(b.action) === null || typeof b.param !== 'string' || !ID_RE.test(b.param)) return fail(`${w}: needs "action" (an action of this widget) and "param" (the action parameter that receives the choice)`);
          out.push({ type: 'select', label, value: b.value, options: o.value, action: b.action as string, param: b.param, ...base });
          break;
        }
        case 'jobProgress':
          out.push({ type: 'jobProgress', ...base });
          break;
        case 'code': {
          if (typeof b.value !== 'string' || !FIELD_RE.test(b.value)) return fail(`${w}: "value" must be a path into the context`);
          const title = b.title === undefined ? undefined : text(b.title, 80);
          if (title === null) return fail(`${w}: "title" must be short text`);
          if (b.filename !== undefined && (typeof b.filename !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(b.filename))) return fail(`${w}: "filename" must be a plain file name`);
          out.push({ type: 'code', ...(title ? { title } : {}), value: b.value, ...(b.filename ? { filename: b.filename as string } : {}), ...base });
          break;
        }
        case 'tabs': {
          if (!Array.isArray(b.tabs) || b.tabs.length < 1 || b.tabs.length > 12) return fail(`${w}: "tabs" must list 1-12 tabs`);
          const tabs: { id: string; label: string; blocks: Block[] }[] = [];
          for (const t of b.tabs as unknown[]) {
            if (!isObj(t) || typeof t.id !== 'string' || !ID_RE.test(t.id) || tabs.some(x => x.id === t.id)) return fail(`${w}: each tab needs a unique "id" (lowercase letters, digits, underscores)`);
            const label = text(t.label, 40);
            if (!label) return fail(`${w}: tab "${t.id}" needs a label`);
            const inner = walk(t.blocks, depth + 1, `${w} tab "${t.id}"`);
            if (!inner.ok) return inner;
            tabs.push({ id: t.id, label, blocks: inner.value });
          }
          out.push({ type: 'tabs', tabs, ...base });
          break;
        }
        case 'editor': {
          const fields = validateEditorFields(b.fields, w);
          if (!fields.ok) return fail(fields.error);
          if (b.param !== undefined && (typeof b.param !== 'string' || !PARAM_RE.test(b.param))) return fail(`${w}: "param" must name the text parameter of the submit actions that receives the settings`);
          if (!Array.isArray(b.submits) || b.submits.length < 1 || b.submits.length > 4) return fail(`${w}: "submits" must list 1-4 buttons`);
          const submits: EditorSubmit[] = [];
          for (const s of b.submits as unknown[]) {
            if (!isObj(s) || actionRef(s.action) === null) return fail(`${w}: each submit needs "action", the id of an action this widget declares`);
            const label = text(s.label, 40);
            if (!label) return fail(`${w}: each submit needs a label`);
            if (s.style !== undefined && s.style !== 'primary' && s.style !== 'danger') return fail(`${w}: submit "style" must be primary or danger`);
            const params: Record<string, string> = {};
            if (s.params !== undefined) {
              if (!isObj(s.params)) return fail(`${w}: submit "params" must map action parameters to values`);
              for (const [p, src] of Object.entries(s.params)) {
                if (!PARAM_RE.test(p)) return fail(`${w}: "${p}" is not a parameter name`);
                const lit = typeof src === 'string' && src.startsWith('literal:') && LITERAL_RE.test(src.slice(8));
                if (typeof src !== 'string' || (!lit && !FIELD_RE.test(src))) return fail(`${w}: submit parameter "${p}" must come from "values.<field>", a context path such as "context.name", or "literal:<text>"`);
                if (src.startsWith('values.') && !fields.value.some(f => f.name === src.slice(7))) return fail(`${w}: submit parameter "${p}" refers to the unknown field "${src.slice(7)}"`);
                params[p] = src;
              }
            }
            submits.push({ action: s.action as string, label, style: s.style === 'danger' ? 'danger' : 'primary', params });
          }
          out.push({ type: 'editor', fields: fields.value, ...(typeof b.param === 'string' ? { param: b.param } : {}), submits, ...base });
          break;
        }
        case 'view': {
          const v = innerView(b.view);
          if (!v.ok) return v;
          if (v.value.type === 'layout') return fail(`${w}: a view block cannot hold another layout`);
          if (b.path !== undefined && (typeof b.path !== 'string' || !FIELD_RE.test(b.path))) return fail(`${w}: "path" must be a dotted path into the widget's data`);
          out.push({ type: 'view', view: v.value, ...(typeof b.path === 'string' ? { path: b.path } : {}), ...base });
          break;
        }
        default:
          return fail(`${w}: unknown block type "${b.type}" (section, tabs, kv, text, code, notice, buttons, form, editor, select, jobProgress or view)`);
      }
    }
    return { ok: true, value: out };
  };
  return walk(rawBlocks, 1, 'layout');
}
