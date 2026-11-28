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
import { validateHideBelow, type WidgetSize } from './size';
import {
  validateBlockSizing, validateDecimals, validateEmphasis, validateGaugeThickness,
  type BlockSize, type Emphasis, type GaugeThickness, type MinItemWidth,
} from './sizing';
import { validateThresholds, type Thresholds } from './thresholds';
import { validateTrend, type TrendSpec } from './trends';
import { validateGaugeItem, type GaugeItem } from './gauges';
import { validateMeters, type MeterItem, type MeterLayout, type MeterShape } from './meters';
import { VALUE_FORMATS, type ValueFormat } from './number-format';
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
  /** Credentials this variant's script receives (see credentials-schema.ts); they reach it as BOSUN_CRED_* only. */
  credentials?: CredentialUse[];
  /** A package script to run before the main one; the action fails without running the main script when it fails. */
  before?: { script: string; args: Record<string, string>; credentials?: CredentialUse[] };
}

/**
 * One credential an action variant or dataset hands to its script. The entry is picked once, on the server: a pinned
 * entry id, the longest match for a URL, or the server's default. Only that entry's fields reach the script.
 */
export interface CredentialUse {
  /** A credential kind the package declares. */
  kind: string;
  /** Script parameter naming a pinned entry id (empty or "auto" means automatic). */
  entry?: string;
  /** Script parameter naming a repository URL to match (with `match.url` in the manifest). */
  url?: string;
  /** Use the server's default entry of this kind. */
  default?: boolean;
  /**
   * Refuse to run when no entry is found (default: true for `default`, false for a URL match so public repositories
   * work without a credential).
   */
  required?: boolean;
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

export const STAT_TONES = ['warning', 'danger', 'success'] as const;
export type StatTone = (typeof STAT_TONES)[number];

/** Count the rows of a list instead of reading one value: `path` (default: the widget's data) and an optional filter. */
export interface StatCount {
  path?: string;
  where?: Cond;
}

/**
 * One card of a `stat` block. `value` and `sub` are templates over the screen's context (like other blocks). `tone` is
 * a fixed tone, or a map of tones to conditions whose first matching entry colours the number. `tab` names a tab of the
 * same screen: clicking the card switches to it (and updates `?tab=` on a page). `bar` is a template that gives 0-100
 * for a thin bar under the number, `unit` is appended to it, `trend` draws a small line of the metric's history and
 * `thresholds` colour the number and bar. `count` makes the number the size of a list (or of the rows matching `where`).
 * `format` writes the value as a byte count, a rate, MB, °C or a duration, as the list and table views do.
 */
export interface StatItem {
  label: string;
  value?: string;
  count?: StatCount;
  sub?: string;
  tone?: StatTone | Partial<Record<StatTone, Cond>>;
  tab?: string;
  bar?: string;
  unit?: string;
  trend?: TrendSpec;
  thresholds?: Thresholds;
  /** How many decimals the value shows (0-3); a `%` value defaults to at most one. */
  decimals?: number;
  /** `muted` dims a secondary item's value. */
  emphasis?: Emphasis;
  format?: ValueFormat;
  /** Level 11: the item shows only while this condition holds (read against the screen's context). */
  when?: Cond;
  /** Level 11: fallbacks tried in order when this item's `when` does not hold; the first one that does is drawn. */
  alternatives?: StatItem[];
}

/** One `label value` pair of an `info` block or of a block's `footer`. `when` hides the pair when it does not hold. */
export interface InfoItem {
  label: string;
  /** A template over the screen's context. */
  value: string;
  /** Level 12: write the value like a field (a byte count, a rate, a duration, a percentage ...). */
  format?: ValueFormat;
  when?: Cond;
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
  /** Select: the options are the entries of this credential kind (plus "Automatic"), loaded from the generic credentials API. */
  credentialsKind?: string;
}

export interface EditorSubmit {
  action: string;
  label: string;
  style: 'primary' | 'danger';
  /** Action parameter -> where its value comes from: `values.<field>`, a path into the screen's context (`context.name`) or `literal:<text>`. */
  params: Record<string, string>;
}

/** Every block may carry `hideBelow`: hidden while the widget is smaller than that size class (see size.ts). */
export type Block = (
  | { type: 'code'; title?: string; value: string; filename?: string; when?: Cond }
  | { type: 'tabs'; tabs: { id: string; label: string; /** A path into the context: the length of the list there shows as a chip after the label. */ count?: string; blocks: Block[] }[]; when?: Cond }
  | { type: 'editor'; fields: EditorField[]; /** The text parameter of the submit actions that receives the settings blob (none: the fields are mapped one by one in each submit's params). */ param?: string; submits: EditorSubmit[]; open?: 'dialog'; label?: string; when?: Cond }
  | { type: 'section'; title: string; defaultOpen: boolean; badges: Badge[]; summary?: string; blocks: Block[]; when?: Cond }
  | { type: 'kv'; items: FieldSpec[]; when?: Cond }
  | { type: 'stat'; items: StatItem[]; size?: BlockSize; minItemWidth?: MinItemWidth; columns?: number; footer?: InfoItem[]; when?: Cond }
  /** `items` draws fixed rings; `path` + `item` draws one ring per row of a data list (level 13). */
  | { type: 'gauges'; items?: GaugeItem[]; path?: string; item?: GaugeItem; empty?: string; size?: BlockSize; minItemWidth?: MinItemWidth; columns?: number; thickness?: GaugeThickness; footer?: InfoItem[]; when?: Cond }
  | { type: 'meters'; path?: string; shape: MeterShape; layout?: MeterLayout; item: MeterItem; empty?: string; when?: Cond }
  | { type: 'info'; items: InfoItem[]; when?: Cond }
  | { type: 'text'; text: string; when?: Cond }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; when?: Cond }
  | { type: 'buttons'; actions: string[]; when?: Cond }
  | { type: 'form'; title?: string; fields: FormField[]; submit: { action: string; label: string; params: Record<string, string> }; open?: 'dialog'; label?: string; when?: Cond }
  | { type: 'select'; label: string; value: string; options: { value: string; label: string }[]; action: string; param: string; when?: Cond }
  | { type: 'jobProgress'; when?: Cond }
  /** `path`: the part of the widget's data the inner view shows (default: all of it). */
  | { type: 'view'; view: ViewSpec; path?: string; when?: Cond }
  /** The entries of one credential kind (public fields, secret status, last use), with add/edit/delete dialogs. */
  | { type: 'credentials'; kind: string; title?: string; description?: string; rowAction?: { action: string; label: string; icon?: string }; when?: Cond }
) & { hideBelow?: WidgetSize };

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
function validateVariantArgs(
  raw: unknown, where: string, scriptId: string, script: ScriptSpec, actionParams: Record<string, ParamSpec>,
): Validated<Record<string, string>> {
  const args: Record<string, string> = {};
  if (raw !== undefined) {
    if (!isObj(raw)) return fail(`${where}: "args" must map script parameters to paths`);
    for (const [name, path] of Object.entries(raw)) {
      if (!(name in script.params)) return fail(`${where}: script "${scriptId}" has no parameter "${name}"`);
      // A path into the context, or a fixed text written as "literal:<text>" (for a script that serves several settings).
      const isLiteral = typeof path === 'string' && path.startsWith('literal:') && LITERAL_RE.test(path.slice(8));
      if (typeof path !== 'string' || (!isLiteral && !FIELD_RE.test(path))) return fail(`${where}: argument "${name}" must be a path such as "state.install.name" or "param.value", or "literal:<text>"`);
      if (path.startsWith('param.') && !(path.slice(6) in actionParams)) return fail(`${where}: argument "${name}" refers to the action parameter "${path.slice(6)}", which is not declared`);
      args[name] = path;
    }
  }
  for (const [name, p] of Object.entries(script.params)) {
    // A parameter with a default of its own need not be mapped: the default is used.
    if (!(name in args) && !(name in actionParams) && p.default === undefined) return fail(`${where}: script "${scriptId}" needs the parameter "${name}": map it in "args" or declare an action parameter with that name`);
  }
  return { ok: true, value: args };
}

/**
 * The credentials a script is handed (`credentials` on a variant, a `before` variant or a dataset). `paramNames` are the
 * script's parameters: an `entry` or `url` names the parameter holding the pinned entry id or the URL.
 */
export function validateCredentialUses(
  raw: unknown, where: string, kinds: ReadonlySet<string>, paramNames: ReadonlySet<string>,
): Validated<CredentialUse[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return fail(`${where}: "credentials" must list 1-4 uses`);
  const out: CredentialUse[] = [];
  const seen = new Set<string>();
  for (const u of raw as unknown[]) {
    if (!isObj(u) || typeof u.kind !== 'string' || !kinds.has(u.kind)) return fail(`${where}: each credential use needs a "kind" this package declares`);
    if (seen.has(u.kind)) return fail(`${where}: the credential kind "${u.kind}" is used twice (its variables would collide)`);
    seen.add(u.kind);
    const use: CredentialUse = { kind: u.kind };
    let any = false;
    for (const key of ['entry', 'url'] as const) {
      if (u[key] === undefined) continue;
      if (typeof u[key] !== 'string' || !PARAM_RE.test(u[key] as string) || !paramNames.has(u[key] as string)) {
        return fail(`${where}: "${key}" must name a parameter of the script`);
      }
      use[key] = u[key] as string;
      any = true;
    }
    if (u.default !== undefined) {
      if (typeof u.default !== 'boolean') return fail(`${where}: "default" must be true or false`);
      use.default = u.default;
      any = true;
    }
    if (u.required !== undefined) {
      if (typeof u.required !== 'boolean') return fail(`${where}: "required" must be true or false`);
      use.required = u.required;
    }
    if (!any) return fail(`${where}: a credential use needs "entry", "url" or "default"`);
    out.push(use);
  }
  return { ok: true, value: out };
}

function validateOneVariant(
  raw: unknown, where: string, scripts: Record<string, ScriptSpec>, actionParams: Record<string, ParamSpec>, kinds: ReadonlySet<string>,
): Validated<ActionVariant> {
  if (!isObj(raw)) return fail(`${where}: each variant must be an object`);
  if (typeof raw.script !== 'string' || !(raw.script in scripts)) return fail(`${where}: a variant must name one of the package scripts`);
  let when: Cond | undefined;
  if (raw.when !== undefined) { const c = cond(raw.when, `${where} variant "when"`); if (!c.ok) return c; when = c.value; }
  const args = validateVariantArgs(raw.args, where, raw.script, scripts[raw.script], actionParams);
  if (!args.ok) return args;
  const paramNames = new Set(Object.keys(scripts[raw.script].params));
  const credentials = validateCredentialUses(raw.credentials, where, kinds, paramNames);
  if (!credentials.ok) return credentials;
  let before: ActionVariant['before'];
  if (raw.before !== undefined) {
    if (!isObj(raw.before)) return fail(`${where}: "before" must be an object`);
    if (typeof raw.before.script !== 'string' || !(raw.before.script in scripts)) return fail(`${where}: "before.script" must name one of the package scripts`);
    const b = validateVariantArgs(raw.before.args, `${where} before`, raw.before.script, scripts[raw.before.script], actionParams);
    if (!b.ok) return b;
    const bc = validateCredentialUses(raw.before.credentials, `${where} before`, kinds, new Set(Object.keys(scripts[raw.before.script].params)));
    if (!bc.ok) return bc;
    before = { script: raw.before.script, args: b.value, ...(bc.value ? { credentials: bc.value } : {}) };
  }
  return { ok: true, value: { ...(when ? { when } : {}), script: raw.script, args: args.value, ...(credentials.value ? { credentials: credentials.value } : {}), ...(before ? { before } : {}) } };
}

export function validateVariants(
  raw: unknown, where: string, scripts: Record<string, ScriptSpec>, actionParams: Record<string, ParamSpec>, kinds: ReadonlySet<string> = new Set(),
): Validated<ActionVariant[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return fail(`${where}: "variants" must list 1-8 variants`);
  const out: ActionVariant[] = [];
  for (const v of raw as unknown[]) {
    const one = validateOneVariant(v, where, scripts, actionParams, kinds);
    if (!one.ok) return one;
    out.push(one.value);
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

function validateEditorFields(raw: unknown, where: string, kinds: ReadonlySet<string> = new Set()): Validated<EditorField[]> {
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
      if (f.credentialsKind !== undefined) {
        if (f.input !== 'select' || typeof f.credentialsKind !== 'string' || !kinds.has(f.credentialsKind)) {
          return fail(`${where}: field "${f.name}": "credentialsKind" must name a credential kind this package declares, on a select field`);
        }
        field.credentialsKind = f.credentialsKind;
      }
      if (!field.options && !field.optionsFrom && field.credentialsKind === undefined && f.remote === undefined) return fail(`${where}: select field "${f.name}" needs "options", "optionsFrom", "credentialsKind" or "remote"`);
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

/** `"open": "dialog"` (with the button's `label`) on a form or editor: the block shows as a button that opens it in a dialog. */
function dialogOpen(b: Obj, where: string): Validated<{ open?: 'dialog'; label?: string }> {
  if (b.open === undefined) {
    if (b.label !== undefined) return fail(`${where}: "label" is only used with "open": "dialog"`);
    return { ok: true, value: {} };
  }
  if (b.open !== 'dialog') return fail(`${where}: "open" must be "dialog" (leave it out to show the block inline)`);
  const label = text(b.label, 40);
  if (!label) return fail(`${where}: "open": "dialog" needs a "label" for its button`);
  return { ok: true, value: { open: 'dialog', label } };
}

/** One stat item (or one of its `alternatives`, which nest at most two deep). */
function validateStatItem(raw: unknown, where: string, statTabs: { tab: string; where: string }[], depth = 0): Validated<StatItem> {
  if (depth > 2) return fail(`${where}: "alternatives" are nested too deeply`);
  if (!isObj(raw)) return fail(`${where}: each stat item must be an object`);
  const label = text(raw.label, 40);
  if (!label) return fail(`${where}: each stat item needs a "label"`);
  const value = raw.value === undefined ? undefined : text(raw.value, 200);
  if (value === null) return fail(`${where}: stat "${label}": "value" must be a template`);
  let count: StatCount | undefined;
  if (raw.count !== undefined) {
    if (!isObj(raw.count)) return fail(`${where}: stat "${label}": "count" must be an object like {"path": "data.items", "where": {...}}`);
    let path: string | undefined;
    if (raw.count.path !== undefined) {
      if (typeof raw.count.path !== 'string' || !FIELD_RE.test(raw.count.path)) return fail(`${where}: stat "${label}": "count.path" must be a dotted path such as "data.items"`);
      path = raw.count.path;
    }
    let whereCond: Cond | undefined;
    if (raw.count.where !== undefined) {
      const c = cond(raw.count.where, `${where} stat "${label}" count "where"`);
      if (!c.ok) return c;
      whereCond = c.value;
    }
    count = { ...(path ? { path } : {}), ...(whereCond ? { where: whereCond } : {}) };
  }
  if (!value && !count) return fail(`${where}: each stat item needs a "value" or a "count"`);
  const sub = raw.sub === undefined ? undefined : text(raw.sub, 200);
  if (sub === null) return fail(`${where}: stat "${label}": "sub" must be text`);
  let tone: StatItem['tone'];
  if (raw.tone !== undefined) {
    if (typeof raw.tone === 'string') {
      if (!(STAT_TONES as readonly string[]).includes(raw.tone)) return fail(`${where}: stat "${label}": "tone" must be one of ${STAT_TONES.join(', ')}`);
      tone = raw.tone as StatTone;
    } else if (isObj(raw.tone)) {
      const keys = Object.keys(raw.tone);
      if (keys.length < 1 || keys.length > STAT_TONES.length || !keys.every(k => (STAT_TONES as readonly string[]).includes(k))) {
        return fail(`${where}: stat "${label}": a "tone" object maps ${STAT_TONES.join(', ')} to conditions`);
      }
      const conditions: Partial<Record<StatTone, Cond>> = {};
      for (const [name, condition] of Object.entries(raw.tone)) {
        const c = cond(condition, `${where} stat "${label}" tone "${name}"`);
        if (!c.ok) return c;
        conditions[name as StatTone] = c.value;
      }
      tone = conditions;
    } else {
      return fail(`${where}: stat "${label}": "tone" must be ${STAT_TONES.join(', ')} or an object of those to conditions`);
    }
  }
  let tab: string | undefined;
  if (raw.tab !== undefined) {
    if (typeof raw.tab !== 'string' || !ID_RE.test(raw.tab)) return fail(`${where}: stat "${label}": "tab" must be a tab id`);
    tab = raw.tab;
    statTabs.push({ tab, where: `${where} stat "${label}"` });
  }
  const bar = raw.bar === undefined ? undefined : text(raw.bar, 200);
  if (bar === null) return fail(`${where}: stat "${label}": "bar" must be a template that gives a number from 0 to 100`);
  const unit = raw.unit === undefined ? undefined : text(raw.unit, 8);
  if (unit === null) return fail(`${where}: stat "${label}": "unit" must be short text`);
  const trend = validateTrend(raw.trend, `${where} stat "${label}"`);
  if (!trend.ok) return trend;
  const thresholds = validateThresholds(raw.thresholds, `${where} stat "${label}"`);
  if (!thresholds.ok) return thresholds;
  const decimals = validateDecimals(raw.decimals, `${where} stat "${label}"`);
  if (!decimals.ok) return decimals;
  const emphasis = validateEmphasis(raw.emphasis, `${where} stat "${label}"`);
  if (!emphasis.ok) return emphasis;
  let format: ValueFormat | undefined;
  if (raw.format !== undefined) {
    if (typeof raw.format !== 'string' || !(VALUE_FORMATS as readonly string[]).includes(raw.format)) {
      return fail(`${where}: stat "${label}": "format" must be one of ${VALUE_FORMATS.join(', ')}`);
    }
    format = raw.format as ValueFormat;
  }
  let when: Cond | undefined;
  if (raw.when !== undefined) {
    const c = cond(raw.when, `${where} stat "${label}" "when"`);
    if (!c.ok) return c;
    when = c.value;
  }
  let alternatives: StatItem[] | undefined;
  if (raw.alternatives !== undefined) {
    if (!Array.isArray(raw.alternatives) || raw.alternatives.length < 1 || raw.alternatives.length > 4) {
      return fail(`${where}: stat "${label}": "alternatives" must list 1-4 tiles`);
    }
    alternatives = [];
    for (const alt of raw.alternatives as unknown[]) {
      const v = validateStatItem(alt, where, statTabs, depth + 1);
      if (!v.ok) return v;
      alternatives.push(v.value);
    }
  }
  return {
    ok: true,
    value: {
      label, ...(value ? { value } : {}), ...(count ? { count } : {}), ...(sub ? { sub } : {}), ...(tone ? { tone } : {}), ...(tab ? { tab } : {}),
      ...(bar ? { bar } : {}), ...(unit ? { unit } : {}), ...(trend.value ? { trend: trend.value } : {}), ...(thresholds.value ? { thresholds: thresholds.value } : {}),
      ...(decimals.value !== undefined ? { decimals: decimals.value } : {}), ...(emphasis.value ? { emphasis: emphasis.value } : {}),
      ...(format ? { format } : {}), ...(when ? { when } : {}), ...(alternatives ? { alternatives } : {}),
    },
  };
}

/** The `label value` pairs of an `info` block or a block's `footer`. */
function validateInfoItems(raw: unknown, where: string): Validated<InfoItem[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return fail(`${where}: "items" must list 1-8 pairs`);
  const items: InfoItem[] = [];
  for (const x of raw as unknown[]) {
    if (!isObj(x)) return fail(`${where}: each item must be an object like {"label": "Mounts", "value": "{n}"}`);
    const label = text(x.label, 40);
    const value = text(x.value, 200);
    if (!label || !value) return fail(`${where}: each item needs a "label" and a "value" template`);
    let format: ValueFormat | undefined;
    if (x.format !== undefined) {
      if (typeof x.format !== 'string' || !(VALUE_FORMATS as readonly string[]).includes(x.format)) {
        return fail(`${where}: item "${label}": "format" must be one of ${VALUE_FORMATS.join(', ')}`);
      }
      format = x.format as ValueFormat;
    }
    let when: Cond | undefined;
    if (x.when !== undefined) {
      const c = cond(x.when, `${where} item "${label}" "when"`);
      if (!c.ok) return c;
      when = c.value;
    }
    items.push({ label, value, ...(format ? { format } : {}), ...(when ? { when } : {}) });
  }
  return { ok: true, value: items };
}

export function validateLayout(
  rawBlocks: unknown, actionIds: ReadonlySet<string>, innerView: ViewValidator, validateFields: (raw: unknown, where: string) => Validated<FieldSpec[]>,
  kinds: ReadonlySet<string> = new Set(),
): Validated<Block[]> {
  let count = 0;
  // Every tab id of this screen, and every stat tile that links to one; checked once the whole tree is known.
  const tabIds = new Set<string>();
  const statTabs: { tab: string; where: string }[] = [];
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
      const hb = validateHideBelow(b.hideBelow, w);
      if (!hb.ok) return hb;
      const base = { ...(when.value ? { when: when.value } : {}), ...hb.value };
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
        case 'stat': {
          if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 12) return fail(`${w}: "items" must list 1-12 stat tiles`);
          const sizing = validateBlockSizing(b, w);
          if (!sizing.ok) return sizing;
          const items: StatItem[] = [];
          for (const raw of b.items as unknown[]) {
            const item = validateStatItem(raw, w, statTabs);
            if (!item.ok) return item;
            items.push(item.value);
          }
          const footer = b.footer === undefined ? undefined : validateInfoItems(b.footer, `${w} footer`);
          if (footer && !footer.ok) return footer;
          out.push({ type: 'stat', items, ...sizing.value, ...(footer && footer.value.length ? { footer: footer.value } : {}), ...base });
          break;
        }
        case 'gauges': {
          const sizing = validateBlockSizing(b, w);
          if (!sizing.ok) return sizing;
          const thickness = validateGaugeThickness(b.thickness, w);
          if (!thickness.ok) return thickness;
          const list = b.path !== undefined || b.item !== undefined;
          if (list && b.items !== undefined) return fail(`${w}: give either "items" or "path" (with "item"), not both`);
          let items: GaugeItem[] | undefined;
          let path: string | undefined;
          let item: GaugeItem | undefined;
          let empty: string | undefined;
          if (list) {
            if (typeof b.path !== 'string' || !FIELD_RE.test(b.path)) return fail(`${w}: "path" must be a dotted path into the widget's data`);
            path = b.path;
            const g = validateGaugeItem(b.item, w);
            if (!g.ok) return g;
            item = g.value;
            if (b.empty !== undefined) {
              const e = text(b.empty, 80);
              if (!e) return fail(`${w}: "empty" must be short text`);
              empty = e;
            }
          } else {
            if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 12) return fail(`${w}: "items" must list 1-12 ring gauges, or give "path" and "item"`);
            items = [];
            for (const rawItem of b.items as unknown[]) {
              const g = validateGaugeItem(rawItem, w);
              if (!g.ok) return g;
              items.push(g.value);
            }
          }
          const footer = b.footer === undefined ? undefined : validateInfoItems(b.footer, `${w} footer`);
          if (footer && !footer.ok) return footer;
          out.push({
            type: 'gauges', ...(items ? { items } : { path: path!, item: item! }), ...(empty ? { empty } : {}), ...sizing.value,
            ...(thickness.value ? { thickness: thickness.value } : {}), ...(footer && footer.value.length ? { footer: footer.value } : {}), ...base,
          });
          break;
        }
        case 'meters': {
          const meters = validateMeters(b, w);
          if (!meters.ok) return meters;
          out.push({ type: 'meters', ...meters.value, ...base });
          break;
        }
        case 'info': {
          const items = validateInfoItems(b.items, w);
          if (!items.ok) return items;
          out.push({ type: 'info', items: items.value, ...base });
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
          const opened = dialogOpen(b, w);
          if (!opened.ok) return opened;
          out.push({ type: 'form', ...(title ? { title } : {}), fields, submit: { action: b.submit.action as string, label, params }, ...opened.value, ...base });
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
          const tabs: { id: string; label: string; count?: string; blocks: Block[] }[] = [];
          for (const t of b.tabs as unknown[]) {
            if (!isObj(t) || typeof t.id !== 'string' || !ID_RE.test(t.id) || tabs.some(x => x.id === t.id)) return fail(`${w}: each tab needs a unique "id" (lowercase letters, digits, underscores)`);
            tabIds.add(t.id);
            const label = text(t.label, 40);
            if (!label) return fail(`${w}: tab "${t.id}" needs a label`);
            let count: string | undefined;
            if (t.count !== undefined) {
              if (typeof t.count !== 'string' || !FIELD_RE.test(t.count)) return fail(`${w}: tab "${t.id}": "count" must be a dotted data path such as "datasets.images"`);
              count = t.count;
            }
            const inner = walk(t.blocks, depth + 1, `${w} tab "${t.id}"`);
            if (!inner.ok) return inner;
            tabs.push({ id: t.id, label, ...(count ? { count } : {}), blocks: inner.value });
          }
          out.push({ type: 'tabs', tabs, ...base });
          break;
        }
        case 'editor': {
          const fields = validateEditorFields(b.fields, w, kinds);
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
          const opened = dialogOpen(b, w);
          if (!opened.ok) return opened;
          out.push({ type: 'editor', fields: fields.value, ...(typeof b.param === 'string' ? { param: b.param } : {}), submits, ...opened.value, ...base });
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
        case 'credentials': {
          if (typeof b.kind !== 'string' || !kinds.has(b.kind)) return fail(`${w}: "kind" must name a credential kind this package declares`);
          const title = b.title === undefined ? undefined : text(b.title, 80);
          if (title === null) return fail(`${w}: "title" must be short text`);
          const description = b.description === undefined ? undefined : text(b.description, 300);
          if (description === null) return fail(`${w}: "description" must be text (max 300 characters)`);
          let rowAction: { action: string; label: string; icon?: string } | undefined;
          if (b.rowAction !== undefined) {
            const ra = b.rowAction as Record<string, unknown>;
            const label = isObj(ra) ? text(ra.label, 40) : null;
            if (!isObj(ra) || typeof ra.action !== 'string' || !label) return fail(`${w}: "rowAction" needs an "action" and a "label"`);
            if (ra.icon !== undefined && typeof ra.icon !== 'string') return fail(`${w}: "rowAction.icon" must be a name`);
            rowAction = { action: ra.action, label, ...(typeof ra.icon === 'string' ? { icon: ra.icon } : {}) };
          }
          out.push({ type: 'credentials', kind: b.kind, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(rowAction ? { rowAction } : {}), ...base });
          break;
        }
        default:
          return fail(`${w}: unknown block type "${b.type}" (section, tabs, kv, stat, gauges, meters, text, code, notice, buttons, form, editor, select, jobProgress, credentials or view)`);
      }
    }
    return { ok: true, value: out };
  };
  const result = walk(rawBlocks, 1, 'layout');
  if (!result.ok) return result;
  const unknownTab = statTabs.find(s => !tabIds.has(s.tab));
  if (unknownTab) return fail(`${unknownTab.where}: "tab" names no tab of this screen ("${unknownTab.tab}")`);
  return result;
}
