/**
 * Size classes of a widget: how much room the widget has on the dashboard, measured on the widget's own content box (like a
 * CSS container query), not on the screen. Every widget gets the same classes, so a spec can say what to show at each size
 * without Bosun knowing anything about the widget. Pure, no React.
 *
 *   class  content width
 *   xs     < 280 px     (a narrow tile: title and one number)
 *   sm     < 420 px
 *   md     < 640 px
 *   lg     >= 640 px    (also what dialogs and pages use)
 */
import { fail, type Validated } from './spec-util';

export const WIDGET_SIZES = ['xs', 'sm', 'md', 'lg'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Lower edge (px) of each class. */
export const WIDGET_SIZE_MIN: Record<WidgetSize, number> = { xs: 0, sm: 280, md: 420, lg: 640 };

const rank = (s: WidgetSize): number => WIDGET_SIZES.indexOf(s);

/** The class of a content box `width` px wide. 0 or unknown (not measured yet) counts as `lg`, so nothing hides before measuring. */
export function sizeClassFor(width: number): WidgetSize {
  if (!Number.isFinite(width) || width <= 0) return 'lg';
  if (width >= WIDGET_SIZE_MIN.lg) return 'lg';
  if (width >= WIDGET_SIZE_MIN.md) return 'md';
  if (width >= WIDGET_SIZE_MIN.sm) return 'sm';
  return 'xs';
}

/** Is a part with `hideBelow` shown at `size`? A part without it always is. */
export const fitsSize = (part: { hideBelow?: WidgetSize }, size: WidgetSize): boolean => !part.hideBelow || rank(size) >= rank(part.hideBelow);

/** How many row actions show as buttons at each size when the spec does not say (the rest go into a "more" menu). */
export const DEFAULT_INLINE_ACTIONS: Record<WidgetSize, number> = { xs: 1, sm: 3, md: 5, lg: Number.POSITIVE_INFINITY };

export type InlineActions = Partial<Record<WidgetSize, number>>;

/**
 * Split a row's actions into the ones shown as buttons and the ones in its "more" menu. `inline` (from the spec) gives the
 * number of buttons per size; a size it leaves out takes the nearest smaller size it gives, else the default. A menu with only
 * one entry is pointless, so that entry stays a button.
 */
export function splitActions<T>(actions: T[], size: WidgetSize, inline?: InlineActions): { shown: T[]; more: T[] } {
  let n: number | undefined;
  if (inline) for (let i = rank(size); i >= 0 && n === undefined; i--) n = inline[WIDGET_SIZES[i]];
  const count = Math.max(0, n ?? DEFAULT_INLINE_ACTIONS[size]);
  if (actions.length <= count + 1) return { shown: actions, more: [] };
  return { shown: actions.slice(0, count), more: actions.slice(count) };
}

/**
 * Split a page-size table row's actions: at most `inline` icons, the rest in the row's ⋯ menu with the destructive ones
 * last (unlike `splitActions`, a menu with one entry is allowed here). Widget-sized tables keep showing every action.
 */
export function splitTableActions<T>(actions: T[], inline: number, destructive: (a: T) => boolean): { shown: T[]; more: T[] } {
  const shown = actions.slice(0, Math.max(0, inline));
  const rest = actions.slice(shown.length);
  return { shown, more: [...rest.filter(a => !destructive(a)), ...rest.filter(destructive)] };
}

/** Validate an optional `hideBelow`; returns the object to spread into the validated part. */
export function validateHideBelow(raw: unknown, where: string): Validated<{ hideBelow?: WidgetSize }> {
  if (raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== 'string' || !(WIDGET_SIZES as readonly string[]).includes(raw) || raw === 'xs') {
    return fail(`${where}: "hideBelow" must be one of sm, md, lg`);
  }
  return { ok: true, value: { hideBelow: raw as WidgetSize } };
}

/** Validate an optional `row.inline` ({"xs": 1, "md": 4}). */
export function validateInline(raw: unknown, where: string): Validated<InlineActions | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${where} must be an object like {"xs": 1, "sm": 2}`);
  const out: InlineActions = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(WIDGET_SIZES as readonly string[]).includes(k)) return fail(`${where}: unknown size "${k}" (use ${WIDGET_SIZES.join(', ')})`);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10) return fail(`${where}.${k} must be a whole number from 0 to 10`);
    out[k as WidgetSize] = v;
  }
  return { ok: true, value: out };
}
