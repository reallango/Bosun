/**
 * Thresholds: colour a number (and its bar or ring) by how high or how low it is. By default a value at or above
 * `danger` is a danger and at or above `warning` a warning; `below` flips the meaning for values where low is bad.
 * Pure (no I/O).
 */
import { fail, isObj, type Validated } from './spec-util';

export type ThresholdTone = 'warning' | 'danger';

export interface BelowThresholds { warning?: number; danger?: number }

export interface Thresholds {
  /** High is bad: at or above this value. */
  warning?: number;
  danger?: number;
  /** Low is bad: at or below these values. Not combined with `warning` / `danger`. */
  below?: BelowThresholds;
}

const KEYS = ['warning', 'danger', 'below'] as const;

function numberOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Validate an optional `thresholds` object. */
export function validateThresholds(raw: unknown, where: string): Validated<Thresholds | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return fail(`${where}: "thresholds" must be an object like {"warning": 75, "danger": 90}`);
  for (const k of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(k)) return fail(`${where}: "thresholds" has an unknown key "${k}" (use warning, danger or below)`);
  }
  const below = raw.below;
  if (below !== undefined) {
    if (raw.warning !== undefined || raw.danger !== undefined) {
      return fail(`${where}: use either warning/danger or below, not both`);
    }
    if (!isObj(below)) return fail(`${where}: "thresholds.below" must be an object like {"warning": 20, "danger": 10}`);
    for (const k of Object.keys(below)) {
      if (k !== 'warning' && k !== 'danger') return fail(`${where}: "thresholds.below" has an unknown key "${k}"`);
    }
    const warning = below.warning === undefined ? undefined : numberOf(below.warning);
    const danger = below.danger === undefined ? undefined : numberOf(below.danger);
    if (warning === null || danger === null) return fail(`${where}: threshold values must be numbers`);
    if (warning === undefined && danger === undefined) return fail(`${where}: "thresholds.below" needs warning and/or danger`);
    if (warning !== undefined && danger !== undefined && warning < danger) {
      return fail(`${where}: a "below" warning must be at or above its danger`);
    }
    return { ok: true, value: { below: { ...(warning !== undefined ? { warning } : {}), ...(danger !== undefined ? { danger } : {}) } } };
  }
  const warning = raw.warning === undefined ? undefined : numberOf(raw.warning);
  const danger = raw.danger === undefined ? undefined : numberOf(raw.danger);
  if (warning === null || danger === null) return fail(`${where}: threshold values must be numbers`);
  if (warning === undefined && danger === undefined) return fail(`${where}: "thresholds" needs warning and/or danger`);
  if (warning !== undefined && danger !== undefined && warning > danger) {
    return fail(`${where}: "warning" must be at or below "danger"`);
  }
  return { ok: true, value: { ...(warning !== undefined ? { warning } : {}), ...(danger !== undefined ? { danger } : {}) } };
}

/** The tone a value takes, or null when it is inside the safe range (or the value is not a number). */
export function thresholdTone(value: unknown, thresholds: Thresholds | undefined): ThresholdTone | null {
  if (!thresholds) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (thresholds.below) {
    const { warning, danger } = thresholds.below;
    if (danger !== undefined && n <= danger) return 'danger';
    if (warning !== undefined && n <= warning) return 'warning';
    return null;
  }
  if (thresholds.danger !== undefined && n >= thresholds.danger) return 'danger';
  if (thresholds.warning !== undefined && n >= thresholds.warning) return 'warning';
  return null;
}
