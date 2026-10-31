/**
 * The logic behind a layout view (spec version 2), kept apart from the React component so it can be tested:
 * which blocks and badges show, which actions are on offer, the starting values of a form and the parameters a form or
 * a select calls an action with. Pure.
 *
 * The context is what conditions and `{templates}` read: `data`, `state`, `config`, `lookups`, `server` and `job`.
 */
import { evalCond, fillTemplate, getPath, type ActionSpec, type Cond, type ParamSpec } from '@/lib/widgets/runtime/spec';
import type { Badge, Block, EditorField, EditorSubmit, FormField } from '@/lib/widgets/runtime/spec-v2';

export interface JobState {
  id: string;
  actionId: string;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'lost';
  steps: string[];
  percent: number | null;
  message: string | null;
  startedAt?: number;
  finishedAt?: number | null;
}

export interface ViewContext {
  data?: unknown;
  /** When the widget's data was collected (ISO text). */
  collectedAt?: string | null;
  state?: unknown;
  config?: Record<string, unknown>;
  lookups?: Record<string, string | null>;
  server?: Record<string, unknown>;
  job?: JobState | null;
  /** Screens: the row a screen was opened for, and what its `load` fetched (alias -> data). */
  context?: unknown;
  datasets?: Record<string, unknown>;
  /** The id of the screen being shown, and the values of a task it is reopened from (secrets are placeholders only the server can resolve). */
  screenId?: string;
  restore?: { values: Record<string, unknown>; savedFrom: string };
}

/** An action as the browser has it: the variants carry only their conditions. */
export type PublicActionLike = Omit<ActionSpec, 'command' | 'windowsCommand' | 'as' | 'timeoutSec' | 'variants'> & { variants?: { when?: Cond }[] };

export const visible = (b: { when?: Cond }, ctx: ViewContext): boolean => !b.when || evalCond(b.when, ctx);

export const visibleBadges = (badges: Badge[], ctx: ViewContext): Badge[] => badges.filter(b => visible(b, ctx));

/** The value of a parameter when nothing supplies one: its default. */
const defaultOf = (spec: ParamSpec): unknown => spec.default;

/** The typed value of a form input (text) for an action parameter; undefined when it cannot be one. */
export function coerceParam(spec: ParamSpec, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (spec.type === 'number') {
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.type === 'boolean') return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined;
  return String(raw) === '' ? undefined : String(raw);
}

/**
 * Is an action worth offering in this context? It must have a variant that applies (a variant without a condition always
 * does); the variant conditions are tested with the action's default parameter values.
 */
export function actionApplies(action: PublicActionLike, ctx: ViewContext): boolean {
  if (!action.variants) return true;
  const param: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(action.params ?? {})) { const d = defaultOf(spec); if (d !== undefined) param[name] = d; }
  return action.variants.some(v => !v.when || evalCond(v.when, { ...ctx, param }));
}

/** The starting values of a form: the current value at each field's path, as text. */
export function formInitial(fields: FormField[], ctx: ViewContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = f.value ? getPath(ctx, f.value) : undefined;
    out[f.name] = v === undefined || v === null ? (f.input === 'select' && f.options?.[0] ? f.options[0].value : '') : String(v);
  }
  return out;
}

/**
 * The parameters to call an action with from a form: each action parameter takes the field `submit.params` maps it to
 * (or the field of the same name), else its default. Returns what is missing so the form can say so.
 */
export function formParams(
  action: Pick<ActionSpec, 'params'>, submit: { params: Record<string, string> }, fields: FormField[], values: Record<string, string>,
): { params: Record<string, unknown>; missing: string[] } {
  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const field = submit.params[name] ?? (fields.some(f => f.name === name) ? name : undefined);
    const v = field !== undefined ? coerceParam(spec, values[field]) : undefined;
    const value = v !== undefined ? v : defaultOf(spec);
    if (value === undefined) {
      const label = fields.find(f => f.name === field)?.label ?? name;
      missing.push(label);
    } else params[name] = value;
  }
  return { params, missing };
}

/** The parameters for a select: the chosen value for `param`, defaults for the rest. */
export function selectParams(action: Pick<ActionSpec, 'params'>, param: string, value: string): { params: Record<string, unknown>; ok: boolean } {
  const params: Record<string, unknown> = {};
  let ok = true;
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    const v = name === param ? coerceParam(spec, value) : defaultOf(spec);
    if (v === undefined) ok = false; else params[name] = v;
  }
  return { params, ok };
}

/** The current choice of a select, as text. */
export function selectCurrent(block: Extract<Block, { type: 'select' }>, ctx: ViewContext): string {
  const v = getPath(ctx, block.value);
  return v === undefined || v === null ? '' : String(v);
}

// ---- editor blocks (screens) ----------------------------------------------------------------------------------

/** Names that look like they hold a secret (a password, a token ...). */
export const SECRET_NAME_RE = /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|pwd|salt|signing)/i;
export const isSecretName = (name: string): boolean => SECRET_NAME_RE.test(name);

export type RowValue = Record<string, string>;
export type EditorValue = string | boolean | string[] | RowValue[];
export type EditorValues = Record<string, EditorValue>;

const asLines = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)) : typeof v === 'string' && v !== '' ? v.split('\n') : []);
const isRowsField = (f: EditorField): boolean => f.input === 'rows';
const isListField = (f: EditorField): boolean => f.input === 'lines' || f.input === 'pairs';
/** Fields that carry a value into the settings (no headings, no buttons, nothing marked transient). */
export const carriesValue = (f: EditorField): boolean => f.input !== 'heading' && f.input !== 'button';
const inSettings = (f: EditorField): boolean => carriesValue(f) && !f.transient;

/** Options of a select field: its own list, or one built from a list in the context (a dataset). */
export function editorOptions(f: EditorField, ctx: ViewContext): { value: string; label: string }[] {
  if (f.options) return f.options;
  if (!f.optionsFrom) return [];
  const list = getPath(ctx, f.optionsFrom.path);
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const value = f.optionsFrom!.value ? getPath(item, f.optionsFrom!.value) : item;
    const label = f.optionsFrom!.label ? getPath(item, f.optionsFrom!.label) : value;
    return { value: String(value ?? ''), label: String(label ?? value ?? '') };
  }).filter(o => o.value !== '');
}

/** The options a select got from the host (`remote`): the list at `path` of the dataset's answer. */
export function remoteOptions(f: EditorField, answer: unknown): { value: string; label: string }[] {
  if (!f.remote) return [];
  const list = f.remote.path ? getPath(answer, f.remote.path) : answer;
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const value = f.remote!.value ? getPath(item, f.remote!.value) : item;
    const label = f.remote!.label ? getPath(item, f.remote!.label) : value;
    return { value: String(value ?? ''), label: String(label ?? value ?? '') };
  }).filter(o => o.value !== '');
}

/** A row of a `rows` field from a stored line (`parse`), with column defaults and `derive` applied; null when the line does not fit. */
export function parseRowLine(f: EditorField, line: string): RowValue | null {
  if (!f.parse || !f.columns) return null;
  const m = new RegExp(f.parse).exec(line.trim());
  if (!m) return null;
  const row: RowValue = {};
  for (const c of f.columns) row[c.name] = m.groups?.[c.name] ?? c.default ?? '';
  for (const [col, rule] of Object.entries(f.derive ?? {})) row[col] = (row[rule.from] ?? '').startsWith(rule.startsWith) ? rule.then : rule.else;
  return row;
}

/** One line of the settings from a row, or null when the row is empty (so a blank row is simply dropped). */
export function formatRow(f: EditorField, row: RowValue): string | null {
  if (!f.format || !f.columns) return null;
  // A row nobody has typed in (every box empty or still at its starting value, like a protocol that starts on TCP) is dropped.
  const untouched = (f.columns ?? []).every(c => { const v = String(row[c.name] ?? '').trim(); return v === '' || v === (c.default ?? (c.input === 'select' ? (c.options?.[0]?.value ?? '') : '')); });
  if (untouched) return null;
  let out = '';
  for (const p of f.format) {
    if (p.lit !== undefined) { out += p.lit; continue; }
    const v = String(row[p.col!] ?? '').trim();
    if ((v === '' && p.optional) || (p.omit && p.omit.includes(v))) continue;
    out += (p.prefix ?? '') + v + (p.suffix ?? '');
  }
  return out.replace(/[\r\n]+/g, ' ');
}

const newRow = (f: EditorField): RowValue => Object.fromEntries((f.columns ?? []).map(c => [c.name, c.default ?? (c.input === 'select' ? (c.options?.[0]?.value ?? '') : '')]));
export { newRow as newEditorRow };

/** The rows of a `rows` field from the lines the context holds. Lines that do not fit keep their text in the first column. */
function rowsFromLines(f: EditorField, v: unknown): RowValue[] {
  return asLines(v).filter(l => l.trim() !== '').map(l => parseRowLine(f, l) ?? { ...newRow(f), [f.columns![0].name]: l.trim() });
}

/** The starting values of an editor: what each field's path holds in the context. */
export function editorInitial(fields: EditorField[], ctx: ViewContext): EditorValues {
  const out: EditorValues = {};
  for (const f of fields) {
    if (!carriesValue(f)) continue;
    const v = f.value ? getPath(ctx, f.value) : undefined;
    if (isRowsField(f)) out[f.name] = rowsFromLines(f, v);
    else if (isListField(f) || f.input === 'textarea') out[f.name] = f.input === 'textarea' ? asLines(v).join('\n') : asLines(v);
    else if (f.input === 'checkbox') out[f.name] = v === true || v === 'true';
    else if (f.input === 'select') {
      const cur = v === undefined || v === null ? '' : String(v);
      const opts = editorOptions(f, ctx);
      out[f.name] = cur !== '' || opts.some(o => o.value === '') || f.remote || f.custom ? cur : (opts[0]?.value ?? '');
    } else out[f.name] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

export const editorFieldVisible = (f: EditorField, values: EditorValues): boolean => !f.when || evalCond(f.when, { values });

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

/**
 * Which fields are hidden because they sit under a collapsed heading the person has not opened. `open` holds the names of the
 * headings that are open.
 */
export function hiddenByHeading(fields: EditorField[], open: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>();
  let closed = false;
  for (const f of fields) {
    if (f.input === 'heading') { closed = f.collapsed === true && !open.has(f.name); continue; }
    if (closed) hidden.add(f.name);
  }
  return hidden;
}

/**
 * The settings blob an editor hands to its action: one `key=value` line per value, in field order. Text, number and select
 * fields give a line when they are not empty, a checkbox always gives `true` or `false`, `lines`, `pairs`, `rows` and text areas give
 * one line per non-empty row. Fields hidden by their `when`, transient fields, headings and buttons give nothing.
 */
export function serializeEditor(fields: EditorField[], values: EditorValues): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (!inSettings(f) || !editorFieldVisible(f, values)) continue;
    const key = f.key ?? f.name;
    const v = values[f.name];
    if (f.input === 'checkbox') { lines.push(`${key}=${v === true ? 'true' : 'false'}`); continue; }
    if (isRowsField(f)) {
      for (const r of (Array.isArray(v) ? v : []) as RowValue[]) { const line = formatRow(f, r); if (line) lines.push(`${key}=${line}`); }
      continue;
    }
    if (isListField(f) || f.input === 'textarea') {
      const rows = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
      for (const r of rows) { const t = oneLine(String(r)).trim(); if (t !== '') lines.push(`${key}=${t}`); }
      continue;
    }
    const s = oneLine(typeof v === 'string' ? v : '').trim();
    if (s !== '') lines.push(`${key}=${s}`);
  }
  return lines.join('\n');
}

const isEmptyValue = (v: EditorValue | undefined): boolean => (
  Array.isArray(v) ? (v as unknown[]).every(x => (typeof x === 'string' ? x.trim() === '' : Object.values(x as RowValue).every(c => c.trim() === ''))) : String(v ?? '').trim() === ''
);

/** The labels of required, visible fields that are empty. */
export function editorMissing(fields: EditorField[], values: EditorValues): string[] {
  return fields.filter(f => f.required && carriesValue(f) && f.input !== 'checkbox' && editorFieldVisible(f, values) && isEmptyValue(values[f.name])).map(f => f.label);
}

/** The risky-looking fields the person has filled in (their `warn` texts), shown before saving. */
export function editorWarnings(fields: EditorField[], values: EditorValues): string[] {
  return fields.filter(f => f.warn && editorFieldVisible(f, values) && (f.input === 'checkbox' ? values[f.name] === true : !isEmptyValue(values[f.name]))).map(f => f.warn as string);
}

/**
 * Apply what a button's dataset answered: `fill` maps field keys (or names) to values. A list or rows field takes a list of lines, a
 * text area takes lines joined, a checkbox "true"/"false". Keys that match no field come back in `unknown`.
 */
export function applyFill(fields: EditorField[], values: EditorValues, fill: unknown, ctx: ViewContext): { values: EditorValues; unknown: string[] } {
  const next: EditorValues = { ...values };
  const unknown: string[] = [];
  if (!fill || typeof fill !== 'object' || Array.isArray(fill)) return { values: next, unknown };
  for (const [k, v] of Object.entries(fill as Record<string, unknown>)) {
    const f = fields.find(x => carriesValue(x) && (x.key ?? x.name) === k) ?? fields.find(x => carriesValue(x) && x.name === k);
    if (!f) { unknown.push(k); continue; }
    if (isRowsField(f)) next[f.name] = rowsFromLines(f, v);
    else if (isListField(f)) next[f.name] = asLines(v);
    else if (f.input === 'textarea') next[f.name] = asLines(v).join('\n');
    else if (f.input === 'checkbox') next[f.name] = v === true || v === 'true';
    else next[f.name] = v === undefined || v === null ? '' : String(v);
    void ctx;
  }
  return { values: next, unknown };
}

/** The value of an argument source: `values.<field>` (the form now), `literal:<text>` or a path into the context. */
export function sourceValue(src: string, values: EditorValues, ctx: ViewContext): string | undefined {
  if (src.startsWith('literal:')) return src.slice(8);
  let raw: unknown;
  if (src.startsWith('values.')) { const v = values[src.slice(7)]; raw = Array.isArray(v) ? (v as unknown[]).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : v; } else raw = getPath(ctx, src);
  if (raw === undefined || raw === null || raw === '') return undefined;
  return String(raw);
}

/** The arguments for a dataset call from the form; `missing` lists the sources that have no value yet. */
export function datasetArgsFromForm(args: Record<string, string>, values: EditorValues, ctx: ViewContext): { args: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, src] of Object.entries(args)) {
    const v = sourceValue(src, values, ctx);
    if (v === undefined) missing.push(src); else out[name] = v;
  }
  return { args: out, missing };
}

/**
 * The parameters of an editor's submit: the settings blob for `param`, the others from `values.<field>`, a context path or a
 * literal. Returns what is missing so the editor can say so.
 */
export function editorSubmitParams(
  action: Pick<ActionSpec, 'params'>, submit: EditorSubmit, param: string | undefined, fields: EditorField[], values: EditorValues, ctx: ViewContext,
): { params: Record<string, unknown>; missing: string[] } {
  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    if (param !== undefined && name === param) { params[name] = serializeEditor(fields, values); continue; }
    const src = submit.params[name];
    let raw: unknown;
    if (src === undefined) raw = undefined;
    else if (src.startsWith('literal:')) raw = src.slice(8);
    else if (src.startsWith('values.')) {
      const f = fields.find(x => x.name === src.slice(7));
      const v = values[src.slice(7)];
      // A select with "Custom" or remote options holds its text; a checkbox its boolean; a list its lines.
      raw = Array.isArray(v) ? (f && isRowsField(f) ? (v as RowValue[]).map(r => formatRow(f, r)).filter(Boolean).join('\n') : (v as string[]).join('\n')) : v;
    } else raw = getPath(ctx, src);
    const v = coerceParam(spec, raw);
    const value = v !== undefined ? v : defaultOf(spec);
    if (value === undefined) missing.push(name); else params[name] = value;
  }
  return { params, missing };
}

/** The arguments a screen's dataset is loaded with: paths into the screen's context, or literals. */
export function screenArgs(args: Record<string, string>, ctx: ViewContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, src] of Object.entries(args)) {
    const v = src.startsWith('literal:') ? src.slice(8) : getPath(ctx, src);
    if (v !== undefined && v !== null) out[name] = typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
  }
  return out;
}

/** The text of a template filled from the context. */
export const text = (template: string, ctx: ViewContext): string => fillTemplate(template, ctx);

export const JOB_ACTIVE = (j: JobState | null | undefined): boolean => !!j && j.status === 'running';

/** How a finished or running job reads in one line. */
export function jobHeadline(j: JobState, actionLabel?: string): string {
  const what = actionLabel ?? j.actionId;
  switch (j.status) {
    case 'running': return `${what} is running${j.percent !== null ? ` (${j.percent}%)` : ''}`;
    case 'success': return `${what} finished${j.message ? `: ${j.message}` : ''}`;
    case 'cancelled': return `${what} was cancelled`;
    case 'lost': return `${what}: Bosun lost track of this job`;
    default: return `${what} failed${j.message ? `: ${j.message}` : ''}`;
  }
}
