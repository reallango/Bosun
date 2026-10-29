/**
 * Turning an action's command template and the caller's parameters into a command to run.
 *
 * Every parameter value is validated against its declaration first, then inserted as ONE quoted
 * word: single quotes for POSIX shells, single quotes with doubled quotes for PowerShell. A value
 * therefore cannot add arguments, operators or a second command, whatever it contains.
 */
import type { ActionSpec, ParamSpec } from '@/lib/widgets/runtime/spec';

export class ParamError extends Error {}

const PLACEHOLDER_RE = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;

/** POSIX shell: wrap in single quotes; a single quote becomes '\''. */
export function quoteSh(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell: single-quoted string, quotes doubled. */
export function quotePs(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Control characters (including newlines) never belong in a parameter. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function validateOne(name: string, spec: ParamSpec, value: unknown): string {
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ParamError(`${name} must be true or false`);
    return value ? 'true' : 'false';
  }
  if (spec.type === 'number') {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ParamError(`${name} must be a number`);
    if (spec.integer && !Number.isInteger(n)) throw new ParamError(`${name} must be a whole number`);
    if (n < spec.min || n > spec.max) throw new ParamError(`${name} must be between ${spec.min} and ${spec.max}`);
    return String(n);
  }
  if (typeof value !== 'string') throw new ParamError(`${name} must be text`);
  if (value.length === 0 || value.length > spec.maxLength) throw new ParamError(`${name} must be 1-${spec.maxLength} characters`);
  if (CONTROL_RE.test(value)) throw new ParamError(`${name} contains control characters`);
  if (spec.values && !spec.values.includes(value)) throw new ParamError(`${name} must be one of: ${spec.values.join(', ')}`);
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new ParamError(`${name} has an invalid format`);
  return value;
}

/** Validate caller-supplied params against an action's declarations. Unknown params are rejected. */
export function validateParams(action: Pick<ActionSpec, 'params'>, input: unknown): Record<string, string> {
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== 'object' || Array.isArray(given)) throw new ParamError('params must be an object');
  const obj = given as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(k in action.params)) throw new ParamError(`Unknown parameter: ${k}`);
  }
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(action.params)) {
    if (obj[name] === undefined) throw new ParamError(`Missing parameter: ${name}`);
    out[name] = validateOne(name, spec, obj[name]);
  }
  return out;
}

/** Fill the placeholders of a command template with already-validated values, quoted for the platform. */
export function renderCommand(template: string, values: Record<string, string>, platform: 'linux' | 'windows'): string {
  const quote = platform === 'windows' ? quotePs : quoteSh;
  return template.replace(PLACEHOLDER_RE, (_, name: string) => {
    if (!(name in values)) throw new ParamError(`Missing parameter: ${name}`);
    return quote(values[name]);
  });
}

/** The command an action runs on a platform (its `windowsCommand` on Windows, when given), or null when it has none for it. */
export function commandFor(action: Pick<ActionSpec, 'command' | 'windowsCommand'>, platform: 'linux' | 'windows'): string | null {
  if (platform === 'windows') return action.windowsCommand ?? null;
  return action.command;
}
