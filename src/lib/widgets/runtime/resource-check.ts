/**
 * Server side of stack/container grants (see resources.ts): find what an action or dataset acts on, and filter
 * lists for someone whose view permission is limited to some stacks or containers.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { hasPermission, resourceFilter } from '@/lib/permissions/authorize';
import type { ResourceContext } from '@/lib/permissions/evaluate';
import type { LoadedSpec } from '@/lib/widgets/runtime/execute';
import { filterRows, rowResource, targetKindFor, type ResourceFields, type ResourceTarget } from './resources';

/** A target value as sent: a plain name (no paths, no options). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class TargetError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_TARGET') { super(message); }
}

/**
 * What an action acts on, from its declared target and the value sent for it. A container is looked up in the
 * widget's latest data to find its stack (so a stack grant covers it); a container that is not in that data yet
 * has no known stack, so only a grant for the container itself (or the whole server) covers it.
 *
 * `kindValue` is the value of the parameter named by `target.byKind` for a target whose kind is not fixed.
 */
export async function resolveTarget(serverId: string, loaded: LoadedSpec, target: ResourceTarget, value: unknown, kindValue?: unknown): Promise<ResourceContext> {
  const kind = targetKindFor(target, kindValue);
  if (!kind) throw new TargetError(`"${'byKind' in target ? target.byKind : 'target.kind'}" must be "container" or "stack"`);
  if (typeof value !== 'string' || !NAME_RE.test(value.trim())) throw new TargetError(`"${target.param}" must name the ${kind}`);
  const name = value.trim();
  if (kind === 'stack') return { kind: 'stack', name };
  const fields = loaded.spec.data.resources;
  if (!fields?.container || !fields.stack) return { kind: 'container', name, stack: null };
  const { loadRuntimeData } = await import('@/lib/widgets/runtime/execute');
  const rt = await loadRuntimeData(serverId, loaded).catch(() => null);
  const rows = Array.isArray(rt?.data) ? rt!.data as unknown[] : [];
  for (const row of rows) {
    const r = rowResource(row, fields);
    if (r?.kind === 'container' && r.name === name) return r;
  }
  return { kind: 'container', name, stack: null };
}

/**
 * What a principal may see of a list under `permission`: 'all', a check per stack/container (only for a list that
 * declares `resources`), or null (nothing: answer 403).
 */
export async function viewFilter(auth: TokenPayload, permission: string, serverId: string, fields: ResourceFields | undefined): Promise<'all' | ((r: ResourceContext) => boolean) | null> {
  const f = await resourceFilter(auth, permission, serverId);
  if (f === 'all' || f === null) return f;
  return fields ? f : (await hasPermission(auth, permission, serverId)) ? 'all' : null;
}

export { filterRows };