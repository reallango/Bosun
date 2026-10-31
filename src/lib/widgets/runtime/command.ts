/**
 * Turning an action's command template and the caller's parameters into a command to run.
 *
 * Every parameter value is validated against its declaration first, then inserted as ONE quoted
 * word: single quotes for POSIX shells, single quotes with doubled quotes for PowerShell. A value
 * therefore cannot add arguments, operators or a second command, whatever it contains.
 */
import type { ActionSpec } from '@/lib/widgets/runtime/spec';
import { ParamError, validateParamValues } from '@/lib/widgets/runtime/script-run';

export { ParamError };

const PLACEHOLDER_RE = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;

/** POSIX shell: wrap in single quotes; a single quote becomes '\''. */
export function quoteSh(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell: single-quoted string, quotes doubled. */
export function quotePs(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Validate caller-supplied params against an action's declarations. Unknown params are rejected. */
export function validateParams(action: Pick<ActionSpec, 'params'>, input: unknown): Record<string, string> {
  return validateParamValues(action.params, input);
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
