/**
 * Widget looks: the named ways a widget can draw its main numbers ("tiles", "gauges", ...). A package declares which
 * looks it offers and which one is the default; Bosun adds the choice to the widget's settings dialog and exposes the
 * saved value to conditions as `config.look`. Pure (no I/O).
 */
import { fail, ID_RE, isObj, text, type Validated } from './spec-util';

/** A grid size in 24-column units. */
export interface LookSize { w: number; h: number }

/**
 * One look. A look may need a different floor than the widget: `min_size` replaces the widget's minimum while that
 * look is selected (bars need less room than tiles), and `default_size` is the size the settings dialog suggests for
 * it. Bosun validates both against the widget's own default size when a package is installed.
 */
export interface WidgetLook { id: string; label: string; min_size?: LookSize; default_size?: LookSize }

export interface LooksSpec {
  /** The look used until the person picks another one. */
  default: string;
  options: WidgetLook[];
}

export const MAX_LOOKS = 6;

/** Read a `{w, h}` grid size (1-48), or null when it is malformed. */
export function readLookSize(raw: unknown): LookSize | null {
  if (!isObj(raw)) return null;
  const w = Math.round(Number(raw.w));
  const h = Math.round(Number(raw.h));
  return w >= 1 && w <= 48 && h >= 1 && h <= 48 ? { w, h } : null;
}

function lookSize(raw: unknown, where: string, key: 'min_size' | 'default_size'): Validated<LookSize | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const size = readLookSize(raw);
  if (!size) return fail(`${where}: "${key}" must be {"w": <1-48>, "h": <1-48>}`);
  return { ok: true, value: size };
}

/** Validate a spec's optional `looks` object. */
export function validateLooks(raw: unknown): Validated<LooksSpec> {
  if (!isObj(raw)) return fail('"looks" must be an object like {"default": "tiles", "options": [...]}');
  if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > MAX_LOOKS) {
    return fail(`"looks.options" must list 1-${MAX_LOOKS} looks`);
  }
  const options: WidgetLook[] = [];
  for (const o of raw.options as unknown[]) {
    if (!isObj(o) || typeof o.id !== 'string' || !ID_RE.test(o.id)) {
      return fail('"looks.options" entries need an "id" of lowercase letters, digits and underscores');
    }
    if (options.some(x => x.id === o.id)) return fail(`"looks.options": the look "${o.id}" is listed twice`);
    const label = text(o.label, 40);
    if (!label) return fail(`"looks.options": look "${o.id}" needs a label (max 40 characters)`);
    const min = lookSize(o.min_size, `"looks.options" look "${o.id}"`, 'min_size');
    if (!min.ok) return min;
    const dflt = lookSize(o.default_size, `"looks.options" look "${o.id}"`, 'default_size');
    if (!dflt.ok) return dflt;
    if (min.value && dflt.value && (dflt.value.w < min.value.w || dflt.value.h < min.value.h)) {
      return fail(`"looks.options" look "${o.id}": "default_size" cannot be smaller than its "min_size"`);
    }
    options.push({ id: o.id, label, ...(min.value ? { min_size: min.value } : {}), ...(dflt.value ? { default_size: dflt.value } : {}) });
  }
  if (typeof raw.default !== 'string' || !options.some(o => o.id === raw.default)) {
    return fail('"looks.default" must be the id of one of the looks');
  }
  return { ok: true, value: { default: raw.default, options } };
}

/**
 * Why a widget's looks cannot fit its own sizes, or null. A look may lower its floor (bars need less room than
 * tiles), but it cannot need more than the widget's default size, or a person picking it would get a widget larger
 * than the one they added.
 */
export function lookSizesProblem(looks: LooksSpec | undefined, widgetDefault: LookSize, widgetMax?: LookSize | null): string | null {
  for (const look of looks?.options ?? []) {
    if (look.min_size && (look.min_size.w > widgetDefault.w || look.min_size.h > widgetDefault.h)) {
      return `look "${look.id}": "min_size" cannot be larger than the widget's default_size`;
    }
    if (look.default_size) {
      if (look.min_size && (look.default_size.w < look.min_size.w || look.default_size.h < look.min_size.h)) {
        return `look "${look.id}": "default_size" cannot be smaller than its "min_size"`;
      }
      if (widgetMax && (look.default_size.w > widgetMax.w || look.default_size.h > widgetMax.h)) {
        return `look "${look.id}": "default_size" cannot be larger than the widget's max_size`;
      }
    }
  }
  return null;
}

/** The floor a look asks for, or null when it does not change the widget's minimum. */
export function lookMinSize(looks: LooksSpec | undefined, lookId: unknown): LookSize | null {
  if (typeof lookId !== 'string') return null;
  return looks?.options.find(o => o.id === lookId)?.min_size ?? null;
}

/** The settings field Bosun adds for a widget that declares looks. */
export interface LookConfigField {
  key: string;
  label: string;
  type: 'select';
  options: string[];
  optionLabels: Record<string, string>;
  default: string;
  description: string;
  /** The sizes a look asks for, so the settings dialog can suggest one and the API can enforce the floor. */
  lookSizes?: Record<string, { min?: LookSize; default?: LookSize }>;
}

export const LOOK_CONFIG_KEY = 'look';

export function lookConfigField(looks: LooksSpec): LookConfigField {
  return {
    key: LOOK_CONFIG_KEY,
    label: 'Look',
    type: 'select',
    options: looks.options.map(o => o.id),
    optionLabels: Object.fromEntries(looks.options.map(o => [o.id, o.label])),
    default: looks.default,
    description: 'How this widget draws its main numbers.',
    ...(looks.options.some(o => o.min_size || o.default_size)
      ? { lookSizes: Object.fromEntries(looks.options.map(o => [o.id, { ...(o.min_size ? { min: o.min_size } : {}), ...(o.default_size ? { default: o.default_size } : {}) }])) }
      : {}),
  };
}

/** The widget's settings with a usable look, so conditions on `config.look` work before anyone saves (and after an option is removed). */
export function withLookDefault(looks: LooksSpec | undefined, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const cfg = config ?? {};
  if (!looks) return cfg;
  const saved = cfg[LOOK_CONFIG_KEY];
  return typeof saved === 'string' && looks.options.some(o => o.id === saved) ? cfg : { ...cfg, [LOOK_CONFIG_KEY]: looks.default };
}
