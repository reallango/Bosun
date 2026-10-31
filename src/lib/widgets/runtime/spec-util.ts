/**
 * Primitives shared by the widget spec validators (spec.ts for version 1, spec-v2.ts for the additions of
 * version 2): the result type, small checks, conditions and action parameters. Pure, no I/O.
 * (Type imports from spec.ts are erased at build time, so there is no runtime cycle.)
 */
import type { Cond, ParamSpec } from './spec';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const PARAM_RE = /^[a-z][a-zA-Z0-9_]{0,29}$/;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : null);
export const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

export function intIn(v: unknown, min: number, max: number, def: number): number | null {
  if (v === undefined) return def;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const COMPOSITE = ['all', 'any', 'not'] as const;
const MAX_COND_DEPTH = 4;

/**
 * A condition. Either a comparison of one field (`equals`, `notEquals`, `in`, `exists`, and in version 2 also `gt`,
 * `gte`, `lt`, `lte` and `newerThan`), or a combination: `all`, `any` (lists of conditions) or `not`.
 */
export function cond(raw: unknown, where: string, depth = 0): Validated<Cond> {
  if (!isObj(raw)) return fail(`${where}: must be an object like {"field": "state", "equals": "running"}`);
  if (depth > MAX_COND_DEPTH) return fail(`${where}: conditions are nested too deeply`);

  const used = COMPOSITE.filter(k => raw[k] !== undefined);
  if (used.length > 0) {
    if (used.length !== 1 || Object.keys(raw).length !== 1) return fail(`${where}: give exactly one of all, any or not, and nothing else`);
    const k = used[0];
    if (k === 'not') {
      const inner = cond(raw.not, `${where} "not"`, depth + 1);
      return inner.ok ? { ok: true, value: { not: inner.value } } : inner;
    }
    const list = raw[k];
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) return fail(`${where}: "${k}" must be a list of 1-10 conditions`);
    const out: Cond[] = [];
    for (const item of list) {
      const inner = cond(item, `${where} "${k}"`, depth + 1);
      if (!inner.ok) return inner;
      out.push(inner.value);
    }
    return { ok: true, value: k === 'all' ? { all: out } : { any: out } };
  }

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
  for (const k of ['gt', 'gte', 'lt', 'lte'] as const) {
    if (raw[k] !== undefined) {
      if (typeof raw[k] !== 'number' || !Number.isFinite(raw[k] as number)) return fail(`${where}: "${k}" must be a number`);
      c[k] = raw[k] as number; n++;
    }
  }
  if (raw.newerThan !== undefined) {
    if (typeof raw.newerThan !== 'string' || !FIELD_RE.test(raw.newerThan)) return fail(`${where}: "newerThan" must be the name of a field that holds a version`);
    c.newerThan = raw.newerThan; n++;
  }
  if (n !== 1) return fail(`${where}: give exactly one of equals, notEquals, in, exists, gt, gte, lt, lte or newerThan`);
  return { ok: true, value: c };
}

export function validateParam(name: string, raw: unknown, where: string): Validated<ParamSpec> {
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
    const maxLength = intIn(raw.maxLength, 1, 2000, 200);
    if (maxLength === null) return fail(`${where}: "maxLength" of "${name}" must be 1-2000`);
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
