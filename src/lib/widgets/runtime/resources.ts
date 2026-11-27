/**
 * Stacks and containers in package specs, so a permission can be granted for one of them instead of a whole server.
 *
 *  - An action (or a dataset) declares `target: { kind, param }`: which of its parameters names the stack or
 *    container it acts on (terminal actions: their `ref`). The action is then checked against that exact target.
 *  - The widget data (or a dataset that lists things) declares `resources: { container?, stack? }`: the row fields
 *    that name each row's container and stack, so someone holding a limited view permission sees only their rows.
 *
 * Pure: shared by the spec validator and the API routes.
 */
import type { GrantResource, ResourceContext, ResourceKind } from '@/lib/permissions/evaluate';
import { nameMatches } from '@/lib/permissions/evaluate';

/**
 * What an action or dataset acts on. A fixed target names its kind; `byKind` takes the kind from another parameter
 * (whose values are "container" and "stack"), so one action can act on either.
 */
export type ResourceTarget =
  | { kind: ResourceKind; param: string }
  | { byKind: string; param: string };
export interface ResourceFields { container?: string; stack?: string }

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type V<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

/** The fixed kind of a target, or null when the kind comes from a parameter. */
export function fixedTargetKind(t: ResourceTarget): ResourceKind | null {
  return 'kind' in t ? t.kind : null;
}

/** The parameter that names the kind, or null for a fixed target. */
export function targetKindParam(t: ResourceTarget): string | null {
  return 'byKind' in t ? t.byKind : null;
}

/** A short description of what a target acts on, for docs and tool descriptions. */
export function targetLabel(t: ResourceTarget): string {
  return 'kind' in t ? `one ${t.kind}` : `one container or stack (pass "${t.byKind}" as "container" or "stack")`;
}

/** The kind a target acts on, from the fixed kind or the `byKind` parameter's value; null when that value is invalid. */
export function targetKindFor(t: ResourceTarget, kindValue: unknown): ResourceKind | null {
  if ('kind' in t) return t.kind;
  return kindValue === 'stack' || kindValue === 'container' ? kindValue : null;
}

export function validateTarget(raw: unknown, where: string, params: readonly string[]): V<ResourceTarget> {
  if (raw === undefined) return { ok: true, value: undefined };
  const t = raw as Record<string, unknown>;
  if (!t || typeof t !== 'object') return { ok: false, error: `${where}: "target" must be { "kind": "stack" | "container", "param": <a parameter name> } or { "byKind": <a parameter name>, "param": <a parameter name> }` };
  const hasKind = t.kind !== undefined;
  const hasByKind = t.byKind !== undefined;
  if (hasKind === hasByKind) return { ok: false, error: `${where}: "target" needs exactly one of "kind" and "byKind"` };
  for (const k of Object.keys(t)) if (k !== 'kind' && k !== 'byKind' && k !== 'param') return { ok: false, error: `${where}: "target" only knows "kind", "byKind" and "param"` };
  if (typeof t.param !== 'string' || !params.includes(t.param)) {
    return { ok: false, error: `${where}: "target.param" must be one of its parameters (${params.join(', ') || 'none'})` };
  }
  if (hasByKind) {
    if (typeof t.byKind !== 'string' || !params.includes(t.byKind)) {
      return { ok: false, error: `${where}: "target.byKind" must be one of its parameters (${params.join(', ') || 'none'})` };
    }
    if (t.byKind === t.param) return { ok: false, error: `${where}: "target.byKind" and "target.param" must name different parameters` };
    return { ok: true, value: { byKind: t.byKind, param: t.param } };
  }
  if (t.kind !== 'stack' && t.kind !== 'container') {
    return { ok: false, error: `${where}: "target.kind" must be "stack" or "container"` };
  }
  return { ok: true, value: { kind: t.kind, param: t.param } };
}

export function validateResourceFields(raw: unknown, where: string): V<ResourceFields> {
  if (raw === undefined) return { ok: true, value: undefined };
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: `${where}: "resources" must be { "container"?: <field>, "stack"?: <field> }` };
  const out: ResourceFields = {};
  for (const k of Object.keys(r)) {
    if (k !== 'container' && k !== 'stack') return { ok: false, error: `${where}: "resources" only knows "container" and "stack"` };
    if (typeof r[k] !== 'string' || !FIELD.test(r[k] as string)) return { ok: false, error: `${where}: "resources.${k}" must be a row field name` };
    out[k] = r[k] as string;
  }
  if (!out.container && !out.stack) return { ok: false, error: `${where}: "resources" needs "container" or "stack"` };
  return { ok: true, value: out };
}

/** The resource a row stands for, by the declared fields: a container (with its stack) or, without a container field, a stack. */
export function rowResource(row: unknown, fields: ResourceFields): ResourceContext | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  const str = (k?: string) => (k && typeof o[k] === 'string' && o[k] ? String(o[k]) : null);
  const container = str(fields.container);
  const stack = str(fields.stack);
  if (fields.container) return container ? { kind: 'container', name: container, stack } : null;
  return stack ? { kind: 'stack', name: stack } : null;
}

/** Does any of `limits` (from a principal's limited grants) cover this resource? */
export function limitsCover(limits: readonly GrantResource[], r: ResourceContext | null): boolean {
  if (!r) return false;
  return limits.some(l => l.kind === 'stack'
    ? nameMatches(l.name, r.kind === 'stack' ? r.name : r.stack)
    : r.kind === 'container' && nameMatches(l.name, r.name));
}

/**
 * Keep only the rows someone may see: `allow` is 'all' or a check per stack/container (rows that name neither are
 * dropped). `data` is the widget's data: a list, or an object whose `rows`/`items`/`data` list holds the rows;
 * anything else is dropped unless `allow` is 'all'.
 */
export function filterRows(data: unknown, fields: ResourceFields, allow: 'all' | ((r: ResourceContext) => boolean)): unknown {
  if (allow === 'all') return data;
  const keep = (rows: unknown[]) => rows.filter(row => { const r = rowResource(row, fields); return !!r && allow(r); });
  if (Array.isArray(data)) return keep(data);
  if (data && typeof data === 'object') {
    const o = { ...(data as Record<string, unknown>) };
    for (const k of ['rows', 'items', 'data']) if (Array.isArray(o[k])) { o[k] = keep(o[k] as unknown[]); return o; }
  }
  return [];
}