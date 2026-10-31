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

export type EditorValue = string | boolean | string[];
export type EditorValues = Record<string, EditorValue>;

const asLines = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x)) : typeof v === 'string' && v !== '' ? v.split('\n') : []);

/** Options of a select field: its own list, or one built from a list in the context (a dataset). */
export function editorOptions(f: EditorField, ctx: ViewContext): { value: string; label: string }[] {
  if (f.options) return f.options;
  if (!f.optionsFrom) return [];
  const list = getPath(ctx, f.optionsFrom.path);
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const value = getPath(item, f.optionsFrom!.value);
    const label = f.optionsFrom!.label ? getPath(item, f.optionsFrom!.label) : value;
    return { value: String(value ?? ''), label: String(label ?? value ?? '') };
  }).filter(o => o.value !== '');
}

/** The starting values of an editor: what each field's path holds in the context. */
export function editorInitial(fields: EditorField[], ctx: ViewContext): EditorValues {
  const out: EditorValues = {};
  for (const f of fields) {
    if (f.input === 'heading') continue;
    const v = f.value ? getPath(ctx, f.value) : undefined;
    if (f.input === 'lines' || f.input === 'pairs' || f.input === 'textarea') out[f.name] = f.input === 'textarea' ? asLines(v).join('\n') : asLines(v);
    else if (f.input === 'checkbox') out[f.name] = v === true || v === 'true';
    else if (f.input === 'select') {
      const cur = v === undefined || v === null ? '' : String(v);
      out[f.name] = cur !== '' || editorOptions(f, ctx).some(o => o.value === '') ? cur : (editorOptions(f, ctx)[0]?.value ?? '');
    } else out[f.name] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

export const editorFieldVisible = (f: EditorField, values: EditorValues): boolean => !f.when || evalCond(f.when, { values });

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

/**
 * The settings blob an editor hands to its action: one `key=value` line per value, in field order. Text, number and select
 * fields give a line when they are not empty, a checkbox always gives `true` or `false`, `lines`, `pairs` and text areas give one
 * line per non-empty row. Fields hidden by their `when` give nothing.
 */
export function serializeEditor(fields: EditorField[], values: EditorValues): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (f.input === 'heading' || !editorFieldVisible(f, values)) continue;
    const key = f.key ?? f.name;
    const v = values[f.name];
    if (f.input === 'checkbox') { lines.push(`${key}=${v === true ? 'true' : 'false'}`); continue; }
    if (f.input === 'lines' || f.input === 'pairs' || f.input === 'textarea') {
      const rows = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
      for (const r of rows) { const t = oneLine(String(r)).trim(); if (t !== '') lines.push(`${key}=${t}`); }
      continue;
    }
    const s = oneLine(typeof v === 'string' ? v : '').trim();
    if (s !== '') lines.push(`${key}=${s}`);
  }
  return lines.join('\n');
}

/** The labels of required, visible fields that are empty. */
export function editorMissing(fields: EditorField[], values: EditorValues): string[] {
  return fields.filter(f => f.required && f.input !== 'heading' && f.input !== 'checkbox' && editorFieldVisible(f, values) && (
    Array.isArray(values[f.name]) ? (values[f.name] as string[]).every(x => x.trim() === '') : String(values[f.name] ?? '').trim() === ''
  )).map(f => f.label);
}

/** The risky-looking fields the person has filled in (their `warn` texts), shown before saving. */
export function editorWarnings(fields: EditorField[], values: EditorValues): string[] {
  return fields.filter(f => f.warn && editorFieldVisible(f, values) && (
    f.input === 'checkbox' ? values[f.name] === true : Array.isArray(values[f.name]) ? (values[f.name] as string[]).some(x => x.trim() !== '') : String(values[f.name] ?? '').trim() !== ''
  )).map(f => f.warn as string);
}

/**
 * The parameters of an editor's submit: the settings blob for `param`, the others from `values.<field>`, a context path or a
 * literal. Returns what is missing so the editor can say so.
 */
export function editorSubmitParams(
  action: Pick<ActionSpec, 'params'>, submit: EditorSubmit, param: string, fields: EditorField[], values: EditorValues, ctx: ViewContext,
): { params: Record<string, unknown>; missing: string[] } {
  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(action.params ?? {})) {
    if (name === param) { params[name] = serializeEditor(fields, values); continue; }
    const src = submit.params[name];
    let raw: unknown;
    if (src === undefined) raw = undefined;
    else if (src.startsWith('literal:')) raw = src.slice(8);
    else if (src.startsWith('values.')) { const v = values[src.slice(7)]; raw = Array.isArray(v) ? v.join('\n') : v; }
    else raw = getPath(ctx, src);
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
