/**
 * Script actions (spec version 2): which variant runs and where each script argument comes from. Pure, no I/O.
 *
 * The context a condition or an argument path reads has the roots `state`, `data`, `config`, `lookups`, `server` and
 * `param` (the action's own parameters), as described in docs/plans/spec-v2/README.md.
 */
import { evalCond, getPath, type ActionSpec, type ParamSpec } from '@/lib/widgets/runtime/spec';
import type { ActionVariant, ScriptSpec } from '@/lib/widgets/runtime/spec-v2';

export interface ActionContext {
  state?: unknown;
  data?: unknown;
  config?: Record<string, unknown>;
  lookups?: Record<string, string | null>;
  server?: Record<string, unknown>;
  param?: Record<string, string | number | boolean>;
}

/** Validated parameter values (as text) back to the types the action declared, for conditions and arguments. */
export function typedParams(declared: Record<string, ParamSpec>, validated: Record<string, string>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const v = validated[name];
    if (v === undefined) continue;
    out[name] = spec.type === 'boolean' ? v === 'true' : spec.type === 'number' ? Number(v) : v;
  }
  return out;
}

/** The first variant whose condition holds (a variant without one always holds), or null when none applies. */
export function selectVariant(action: Pick<ActionSpec, 'variants'>, ctx: ActionContext): ActionVariant | null {
  for (const v of action.variants ?? []) {
    if (!v.when || evalCond(v.when, ctx)) return v;
  }
  return null;
}

/**
 * The values to hand to the variant's script, before they are validated against the script's declaration: from the
 * variant's `args` (a context path, or `literal:<text>`), else from the action parameter of the same name. A number or
 * boolean from the context becomes text for a text parameter.
 */
export function resolveScriptArgs(variant: ActionVariant, script: ScriptSpec, ctx: ActionContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(script.params)) {
    const path = variant.args[name];
    let value: unknown;
    if (path === undefined) value = ctx.param?.[name];
    else if (path.startsWith('literal:')) value = path.slice(8);
    else value = getPath(ctx, path);
    if (value === undefined || value === null || value === '') value = spec.default;
    if (spec.type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) value = String(value);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
