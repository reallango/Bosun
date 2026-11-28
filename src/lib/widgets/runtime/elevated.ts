/**
 * Elevated options: a plain action refuses them and its script prints `needs elevated container options (...)`.
 * Usually the package also has an action that allows them, and the error and an access request should name it
 * instead of only naming the permission.
 *
 * Nothing here knows which widget it is: the link is in the actions themselves. A plain action's variant runs a
 * script without the switch (`allow_risky: "literal:false"`, or not at all); its elevated counterpart runs the same
 * script with the same other arguments and `allow_risky: "literal:true"`. (`allow_risky` is the switch a package
 * script uses to accept such options; see widgets/README.md.)
 */
import { permissionDef } from '@/lib/permissions/catalog';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import type { ActionSpec } from './spec';

const SWITCH = 'allow_risky';

/** The part of a variant that says which script runs with which arguments, ignoring whether elevated options are allowed. */
function signature(v: { script: string; args: Record<string, string> }): string {
  const args = Object.entries(v.args)
    .filter(([k]) => k !== SWITCH)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [v.script, ...args.map(([k, val]) => `${k}=${val}`)].join('\u0000');
}

/** The action that runs the same script as this one but allows elevated options, or null when there is none. */
export function elevatedSiblingOf(action: ActionSpec, actions: readonly ActionSpec[]): ActionSpec | null {
  for (const mine of action.variants ?? []) {
    if (mine.args[SWITCH] === 'literal:true') continue;
    const sig = signature(mine);
    for (const other of actions) {
      if (other.id === action.id) continue;
      if ((other.variants ?? []).some(v => v.args[SWITCH] === 'literal:true' && signature(v) === sig)) return other;
    }
  }
  return null;
}

/** The refusal a script prints, with the reasons in parentheses: `needs elevated container options (capability SYS_ADMIN)`. */
export const ELEVATED_REFUSAL = /needs elevated container options \(([^)]*)\)/;

/** Add the action that would allow these options, and the permission it needs, to a plain action's refusal. */
export function explainElevated(
  message: string | null | undefined,
  action: ActionSpec,
  actions: readonly ActionSpec[],
  permissionLabel: (id: string) => string,
): string | null | undefined {
  if (!message || !ELEVATED_REFUSAL.test(message)) return message;
  const sibling = elevatedSiblingOf(action, actions);
  if (!sibling) return message;
  const permission = permissionLabel(sibling.permission);
  return message.replace(ELEVATED_REFUSAL, whole =>
    `${whole}: use "${sibling.label}" (${sibling.id}), which needs the "${permission}" permission`);
}

/** `explainElevated` with the labels of the installed package permissions. */
export async function explainElevatedFor(
  message: string | null | undefined,
  action: ActionSpec,
  actions: readonly ActionSpec[],
): Promise<string | null | undefined> {
  if (!message || !ELEVATED_REFUSAL.test(message)) return message;
  const defs = await registeredPermissionDefs();
  return explainElevated(message, action, actions, id => permissionDef(id, defs)?.label ?? id);
}

/** What an access request for a plain action adds when the requester already holds the plain action's permission. */
export function elevatedHint(
  action: ActionSpec,
  actions: readonly ActionSpec[],
  permissionLabel: (id: string) => string,
): string {
  const sibling = elevatedSiblingOf(action, actions);
  if (!sibling) return '';
  return ` Options that need elevation use the "${sibling.label}" action (${sibling.id}), which needs the "${permissionLabel(sibling.permission)}" permission.`;
}
