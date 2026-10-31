/**
 * Settings of a widget that only people holding a permission may change (`requires_permission` on a field of the
 * package's `config_schema`). A package uses it for a setting that amounts to running something on a host, such as the
 * command of a Custom Command widget. The rule is generic: Bosun knows no widget, it reads the field's declaration.
 */

export interface GuardedField { key: string; label?: string; requires_permission?: string }

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface GuardedChange { key: string; label: string; permission: string }

/**
 * The guarded settings that applying `next` to `current` would change. With `replace` (the whole config is replaced) a
 * guarded setting that is missing from `next` counts as changed when it was set before. Values compare as text, so
 * sending the same value again is not a change.
 */
export function guardedChanges(schema: GuardedField[] | undefined, current: unknown, next: unknown, replace = false): GuardedChange[] {
  const cur = asObject(current);
  const nxt = asObject(next);
  const out: GuardedChange[] = [];
  for (const f of schema ?? []) {
    if (!f.requires_permission) continue;
    const has = Object.prototype.hasOwnProperty.call(nxt, f.key);
    if (!has && !replace) continue;
    if (String(nxt[f.key] ?? '') !== String(cur[f.key] ?? '')) out.push({ key: f.key, label: f.label ?? f.key, permission: f.requires_permission });
  }
  return out;
}
