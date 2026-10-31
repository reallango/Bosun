/**
 * The logic behind a layout view (spec version 2), kept apart from the React component so it can be tested:
 * which blocks and badges show, which actions are on offer, the starting values of a form and the parameters a form or
 * a select calls an action with. Pure.
 *
 * The context is what conditions and `{templates}` read: `data`, `state`, `config`, `lookups`, `server` and `job`.
 */
import { evalCond, fillTemplate, getPath, type ActionSpec, type Cond, type ParamSpec } from '@/lib/widgets/runtime/spec';
import type { Badge, Block, FormField } from '@/lib/widgets/runtime/spec-v2';

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
  state?: unknown;
  config?: Record<string, unknown>;
  lookups?: Record<string, string | null>;
  server?: Record<string, unknown>;
  job?: JobState | null;
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
