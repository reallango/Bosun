/**
 * Widget looks: the named ways a widget can draw its main numbers ("tiles", "gauges", ...). A package declares which
 * looks it offers and which one is the default; Bosun adds the choice to the widget's settings dialog and exposes the
 * saved value to conditions as `config.look`. Pure (no I/O).
 */
import { fail, ID_RE, isObj, text, type Validated } from './spec-util';

export interface WidgetLook { id: string; label: string }

export interface LooksSpec {
  /** The look used until the person picks another one. */
  default: string;
  options: WidgetLook[];
}

export const MAX_LOOKS = 6;

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
    options.push({ id: o.id, label });
  }
  if (typeof raw.default !== 'string' || !options.some(o => o.id === raw.default)) {
    return fail('"looks.default" must be the id of one of the looks');
  }
  return { ok: true, value: { default: raw.default, options } };
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
  };
}

/** The widget's settings with a usable look, so conditions on `config.look` work before anyone saves (and after an option is removed). */
export function withLookDefault(looks: LooksSpec | undefined, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const cfg = config ?? {};
  if (!looks) return cfg;
  const saved = cfg[LOOK_CONFIG_KEY];
  return typeof saved === 'string' && looks.options.some(o => o.id === saved) ? cfg : { ...cfg, [LOOK_CONFIG_KEY]: looks.default };
}
