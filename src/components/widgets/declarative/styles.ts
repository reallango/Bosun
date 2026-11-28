/** Shared classes for the declarative widget renderer. Everything here uses theme
 * tokens so widgets follow the app shell in both light and dark mode. */
import type { MinItemWidth } from '@/lib/widgets/runtime/sizing';

/** Small text input and select used by forms, editors and the list filter. */
export const inputClass =
  'w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/40 disabled:opacity-40';

/** Quiet bordered button: actions, cancel, dismiss, add row, copy, reload. */
export const buttonClass =
  'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40';

/** Icon-only button: remove a row, close a dialog. */
export const iconButtonClass =
  'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

/**
 * Buttons of a toolbar (a `buttons` block and the dialog-form triggers above a view) share one height, padding and font
 * size so they line up. Exactly one may be solid (the primary look); the rest are outlined, and a destructive action gets
 * the outlined destructive look. Screens and pages use the large set, widget-sized toolbars the small one.
 */
export const TOOLBAR_BUTTON_SIZE = {
  large: 'inline-flex h-8 items-center justify-center gap-1 rounded-md px-3 text-sm font-medium disabled:opacity-40',
  small: 'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-40',
} as const;

export type ToolbarButtonVariant = 'primary' | 'outline' | 'destructive';

const TOOLBAR_PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90';
const TOOLBAR_OUTLINE = 'border border-border bg-transparent hover:bg-muted';
const TOOLBAR_DESTRUCTIVE = 'border border-destructive/50 text-destructive hover:bg-destructive/10';

export function toolbarButtonClass(size: 'large' | 'small', variant: ToolbarButtonVariant): string {
  const look = variant === 'primary' ? TOOLBAR_PRIMARY : variant === 'destructive' ? TOOLBAR_DESTRUCTIVE : TOOLBAR_OUTLINE;
  return `${TOOLBAR_BUTTON_SIZE[size]} ${look}`;
}

const submitButtonClass = 'inline-flex items-center gap-1 rounded-md px-3 py-1.5 font-medium disabled:opacity-40';

/** Solid submit button of an editor. */
export const primarySubmitClass = `${submitButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`;
// A fixed red-600 rather than the destructive token: in dark mode that token (#ef4444) under white text is ~3.8:1, below WCAG AA.
export const dangerSubmitClass = `${submitButtonClass} bg-red-600 text-white hover:bg-red-700`;

/** Notice boxes, by level. Green and amber keep their fixed status colours. */
export const NOTICE_CLASS = {
  info: 'border-primary/30 bg-primary/10 text-primary',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
} as const;

/**
 * Stat tiles and ring gauges inside a widget fill its body: the grid grows columns and rows to use the width and
 * height, and the numbers scale with the tile (container query units) instead of the screen. In dialogs and pages the
 * blocks keep their normal reading size (see fill.ts).
 *
 * A block's `minItemWidth` picks one of these fixed classes; `columns` picks a fixed count instead (both are validated
 * keys, never CSS from a package).
 */
export const FILL_GRID_MIN: Record<MinItemWidth, string> = {
  xs: 'grid h-full min-h-0 auto-rows-fr gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,5.5rem),1fr))]',
  sm: 'grid h-full min-h-0 auto-rows-fr gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,7rem),1fr))]',
  md: 'grid h-full min-h-0 auto-rows-fr gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr))]',
  lg: 'grid h-full min-h-0 auto-rows-fr gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10.5rem),1fr))]',
};

/** The default filling grid (what a block gets when it does not name a `minItemWidth`). */
export const FILL_GRID = FILL_GRID_MIN.md;

/** A filling grid with a fixed number of columns (`columns`). */
export const FILL_GRID_COLUMNS: Record<number, string> = {
  1: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-1',
  2: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-2',
  3: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-3',
  4: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-4',
  5: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-5',
  6: 'grid h-full min-h-0 auto-rows-fr gap-2 grid-cols-6',
};

/** A fixed column count outside a filling widget (a dialog or page). */
export const STAT_GRID_COLUMNS: Record<number, string> = {
  1: 'grid gap-2 grid-cols-1', 2: 'grid gap-2 grid-cols-2', 3: 'grid gap-2 grid-cols-3',
  4: 'grid gap-2 grid-cols-4', 5: 'grid gap-2 grid-cols-5', 6: 'grid gap-2 grid-cols-6',
};

/** The same grid on the smallest widget: one compact row, so nothing overflows. */
export const FILL_GRID_XS = 'grid h-full min-h-0 grid-flow-col auto-cols-fr grid-rows-1 gap-1.5';

/** A tile or gauge card in a filling grid: a size container, so its text scales with its width and its height. */
const FILL_CARD_BASE = 'flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card [container-type:size]';

export const FILL_CARD = `${FILL_CARD_BASE} justify-evenly gap-1 p-2.5 text-left`;

/** The same card on a short widget: less padding and gaps so the number and ring keep their room. */
export const FILL_CARD_COMPACT = `${FILL_CARD_BASE} justify-center gap-0.5 p-1.5 text-left`;

export const FILL_GAUGE_CARD = `${FILL_CARD_BASE} items-center justify-evenly gap-1 p-2.5 text-center`;

export const FILL_GAUGE_CARD_COMPACT = `${FILL_CARD_BASE} items-center justify-center gap-0.5 p-1.5 text-center`;

/**
 * The main number of a tile: the renderer sets its size inline from the value's length (see sizing.ts), so it is never
 * ellipsised for a typical value. The class keeps the fallback size for a card that has not been measured yet.
 */
export const FILL_VALUE = 'whitespace-nowrap font-semibold leading-none tabular-nums [font-size:clamp(1.05rem,max(15cqw,25cqmin),6rem)]';

/** A three-row tile has no room for a number that fills a wide card; this keeps it and the label inside. */
export const FILL_VALUE_COMPACT = 'whitespace-nowrap font-semibold leading-none tabular-nums [font-size:clamp(1.05rem,min(15cqw,22cqmin),6rem)]';

/** The value inside a ring is a share of the ring area, so it stays inside the circle at every card size. */
export const FILL_GAUGE_VALUE = 'whitespace-nowrap font-semibold leading-none tabular-nums [font-size:clamp(0.8rem,24cqmin,3.5rem)]';

/** A tile's or gauge's label: never below 0.85rem, growing with the card up to 1.1rem. */
export const FILL_LABEL = 'truncate text-muted-foreground [font-size:clamp(0.85rem,max(3.4cqw,5cqmin),1.1rem)]';

/** The label under the value inside a ring, used when the card is too short to put it above the ring. */
export const FILL_GAUGE_LABEL = 'truncate text-muted-foreground [font-size:clamp(0.75rem,15cqmin,1rem)]';

export const FILL_SUB = 'truncate text-muted-foreground [font-size:clamp(0.7rem,max(3cqw,4.5cqmin),0.9rem)]';

/** A sparkline stretches to the tile width; its height grows with the card but leaves the number room. */
export const SPARKLINE = 'block w-full [height:clamp(0.9rem,min(16cqw,22cqh),5rem)]';

/**
 * A `meters` block: one compact row per item of a list, with a bar or a small ring. The list scrolls inside the room the
 * widget leaves; a short widget tightens the gaps and drops the sub-line (the label and value stay).
 */
export const METER_LIST = 'space-y-1.5 overflow-auto';
export const METER_LIST_COMPACT = 'space-y-1 overflow-auto';
export const METER_ROW = 'flex min-w-0 items-center gap-2';
export const METER_VALUE = 'shrink-0 text-xs tabular-nums';
export const METER_SUB = 'truncate text-[11px] text-muted-foreground';
export const METER_RING = 'relative size-9 shrink-0';
export const METER_RING_COMPACT = 'relative size-7 shrink-0';
export const METER_RING_TRACK = 'stroke-muted';

/** `layout: "grid"`: many small meters in columns, each a thin vertical bar with its label under it. */
export const METER_GRID =
  'grid h-full min-h-0 auto-rows-fr gap-1 overflow-auto [grid-template-columns:repeat(auto-fit,minmax(min(100%,2.1rem),1fr))]';
export const METER_GRID_CELL = 'flex min-h-0 min-w-0 flex-col items-center gap-0.5';
export const METER_GRID_TRACK = 'flex w-full min-h-0 flex-1 items-end overflow-hidden rounded bg-muted';

/** The dialog shell shared by screen dialogs and forms that open behind a button. */
export const DIALOG_OVERLAY = 'fixed inset-0 z-50 bg-black/50';

export const DIALOG_CONTENT =
  'fixed inset-x-2 top-4 z-50 mx-auto flex max-h-[92vh] flex-col rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl';

export const DIALOG_WIDTH: Record<string, string> = { md: 'sm:max-w-lg', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' };

export const DIALOG_HEADER = 'mb-3 flex items-start justify-between gap-2';

export const DIALOG_TITLE = 'min-w-0 truncate text-base font-semibold';

export const DIALOG_FOOTER = 'mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3';
