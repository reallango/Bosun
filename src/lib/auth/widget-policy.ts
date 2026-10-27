/**
 * Widget config fields that amount to running arbitrary commands on a host
 * (the Custom Command widget's `command`). Changing them needs Full access;
 * operators may still rename/resize widgets and edit other config fields.
 */
import { hasRole } from './levels';

export const COMMAND_CONFIG_KEYS = ['command'] as const;

export const COMMAND_CHANGE_FORBIDDEN =
  "Changing a Custom Command widget's command requires Full access (admin).";

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Does applying `next` (a partial or full config) change any command field of `current`? */
export function changesCommand(current: unknown, next: unknown): boolean {
  const cur = asObject(current);
  const nxt = asObject(next);
  return COMMAND_CONFIG_KEYS.some(
    k => Object.prototype.hasOwnProperty.call(nxt, k) && String(nxt[k] ?? '') !== String(cur[k] ?? ''),
  );
}

/** For full replacement (PATCH config=...): also a removed command counts as a change. */
export function replacesCommand(current: unknown, next: unknown): boolean {
  const cur = asObject(current);
  const nxt = asObject(next);
  return COMMAND_CONFIG_KEYS.some(k => String(nxt[k] ?? '') !== String(cur[k] ?? ''));
}

export function mayChangeCommand(role: unknown): boolean {
  return hasRole(role, 'admin');
}
