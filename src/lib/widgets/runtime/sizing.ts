/**
 * Bounded sizing keys for widget authors: how large a block's numbers are, how many items share a row and how thick a
 * ring is. Every key maps to a fixed token-based class or a CSS expression in core; a package can never inject CSS.
 * The fit helpers turn the length of a rendered value into a font size that keeps it inside its tile or ring. Pure
 * (no I/O), so the calculation and the validation can be tested on their own.
 */
import { fail, type Validated } from './spec-util';
import { withUnit } from './number-format';

export const BLOCK_SIZES = ['sm', 'md', 'lg'] as const;
export type BlockSize = (typeof BLOCK_SIZES)[number];

export const MIN_ITEM_WIDTHS = ['xs', 'sm', 'md', 'lg'] as const;
export type MinItemWidth = (typeof MIN_ITEM_WIDTHS)[number];

export const GAUGE_THICKNESSES = ['thin', 'normal', 'thick'] as const;
export type GaugeThickness = (typeof GAUGE_THICKNESSES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const EMPHASES = ['normal', 'muted'] as const;
export type Emphasis = (typeof EMPHASES)[number];

/** How much a block's `size` multiplies the value and its label. */
export const SIZE_SCALE: Record<BlockSize, number> = { sm: 0.85, md: 1, lg: 1.2 };

/** The number of characters a string takes on screen (code points, so "°C" is two). */
export const textLength = (text: string): number => Array.from(text).length;

/** The length of the widest value of a block, at least 1 (used to size every item in it alike). */
export function longestValueLength(values: readonly string[]): number {
  return Math.max(1, ...values.map(textLength));
}

// A tabular digit is about 0.6 em wide. These limits keep a value near 70% of the room it has, leaving the ring's
// stroke and a little air free.
export const TILE_FIT_CQW = 140;
export const GAUGE_FIT_CQMIN = 92;

/** The smallest readable value: a ring never goes below 0.75rem (12px), a tile below 0.9rem (14.4px). */
export const TILE_VALUE_FLOOR_REM = 0.9;
export const GAUGE_VALUE_FLOOR_REM = 0.75;

/** A split unit sits at 70% of its number, but never below 0.6rem. */
export const UNIT_SCALE = 0.7;
export const UNIT_FLOOR_REM = 0.6;

/** The largest value size in each kind of card (the old `clamp` maxima). */
const TILE_VALUE_MAX_REM = 6;
const GAUGE_VALUE_MAX_REM = 3.5;

/** CSS `rem` is 16px in this app; the fit helpers use it to compare a floor with a measured container. */
const ROOT_FONT_PX = 16;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const rounded = (n: number): string => String(Number(n.toFixed(2)));

/** The widest font (in cqw) at which `chars` characters still fit a tile. */
export const tileFitCqw = (chars: number): number => TILE_FIT_CQW / Math.max(1, chars);

/** The widest font (in cqmin) at which `chars` characters still fit inside a ring with this stroke. */
export const gaugeFitCqmin = (chars: number, stroke = 10): number =>
  (GAUGE_FIT_CQMIN * (100 - 2 * stroke) / 80) / Math.max(1, chars);

/**
 * The CSS font-size of a tile's value before the card has been measured: it follows the card, but never grows past
 * what the value's length allows and never shrinks below the readable floor.
 */
export function tileValueFontSize(chars: number, size: BlockSize = 'md', compact = false): string {
  const room = compact ? 'min(15cqw,22cqmin)' : 'max(15cqw,25cqmin)';
  return `max(${TILE_VALUE_FLOOR_REM}rem, calc(${SIZE_SCALE[size]} * min(${room}, calc(${rounded(tileFitCqw(chars))}cqw), ${TILE_VALUE_MAX_REM}rem)))`;
}

/** The CSS font-size of a value inside a ring before the card has been measured. */
export function gaugeValueFontSize(chars: number, size: BlockSize = 'md', stroke = 10): string {
  return `max(${GAUGE_VALUE_FLOOR_REM}rem, calc(${SIZE_SCALE[size]} * min(24cqmin, calc(${rounded(gaugeFitCqmin(chars, stroke))}cqmin), ${GAUGE_VALUE_MAX_REM}rem)))`;
}

/** CSS font-size of a block's label, scaled with its value. */
export function labelFontSize(size: BlockSize): string {
  return `calc(${SIZE_SCALE[size]} * clamp(0.85rem, max(3.4cqw,5cqmin), 1.1rem))`;
}

/** CSS font-size of the label inside a ring, scaled with the value. */
export function gaugeLabelFontSize(size: BlockSize): string {
  return `calc(${SIZE_SCALE[size]} * clamp(0.75rem,15cqmin,1rem))`;
}

/** One value of a block: the formatted number and its unit, kept apart so the unit can move to its own line. */
export interface ValueText {
  number: string;
  unit?: string;
}

/** The measured content box of a card, in px (what a CSS container query unit is relative to). */
export interface FitRoom {
  width: number;
  height: number;
}

export interface TileFitOptions extends FitRoom {
  size?: BlockSize;
  compact?: boolean;
}

export interface GaugeFitOptions extends FitRoom {
  size?: BlockSize;
  stroke?: number;
}

/** What the renderer needs to show a block's values: one shared size, and whether the unit moves to its own line. */
export interface ValueFit {
  /** CSS font-size of the number line. */
  fontSize: string;
  /** CSS font-size of the unit line (used only when `split`). */
  unitFontSize: string;
  /** Put the unit under the number instead of next to it. */
  split: boolean;
  /** When split, let `%` move to its own line too (the bare number did not fit at the floor). */
  splitPercent: boolean;
}

/** The line a value shows when its unit is split: the number, plus `%` while that still fits at the floor. */
const splitLine = (value: ValueText, splitPercent: boolean): string =>
  withUnit(value.number, value.unit?.startsWith('%') && !splitPercent ? value.unit : undefined);

/** Should this unit move to its own line? (A `%` stays on the number's line unless the number itself did not fit.) */
export const unitOnOwnLine = (unit: string | undefined, fit: ValueFit): boolean =>
  fit.split && !!unit && !(unit.startsWith('%') && !fit.splitPercent);

/**
 * Decide the block-wide fit from the measured card. `fitPx` gives the font at which `chars` characters fit (before the
 * floor), `roomPx` the largest font the card's proportions allow, and `legacy` the CSS to use before measuring.
 *
 * A value whose number and unit do not both fit at the floor is split: the number stays on the first line at the
 * largest size that fits, and the unit follows on a smaller line. `%` is part of the number, so it moves only when the
 * bare number itself cannot reach the floor. The decision is made once for the whole block, from its widest value.
 */
function fitValues(values: readonly ValueText[], size: BlockSize, measured: boolean, fitPx: (chars: number) => number, roomPx: number, floorRem: number, maxRem: number, legacy: string): ValueFit {
  const fullChars = longestValueLength(values.map(v => withUnit(v.number, v.unit)));
  if (!measured) {
    return { fontSize: legacy, unitFontSize: `${UNIT_SCALE}em`, split: false, splitPercent: false };
  }
  const floorPx = floorRem * ROOT_FONT_PX;
  const canSplit = values.some(v => !!v.unit);
  const split = canSplit && fitPx(fullChars) < floorPx;
  const percentNumbers = values.filter(v => v.unit?.startsWith('%')).map(v => textLength(v.number));
  const longestPercent = Math.max(0, ...percentNumbers);
  const splitPercent = split && longestPercent > 0 && fitPx(longestPercent) < floorPx;
  const chars = split ? Math.max(1, ...values.map(v => textLength(splitLine(v, splitPercent)))) : fullChars;
  const valuePx = Math.max(floorPx, SIZE_SCALE[size] * Math.min(roomPx, fitPx(chars), maxRem * ROOT_FONT_PX));
  return {
    fontSize: `max(${floorRem}rem, ${round2(valuePx)}px)`,
    unitFontSize: `max(${UNIT_FLOOR_REM}rem, ${round2(valuePx * UNIT_SCALE)}px)`,
    split,
    splitPercent,
  };
}

/** Fit a `stat` block's values to its measured tile. */
export function fitTileValues(values: readonly ValueText[], opts: TileFitOptions): ValueFit {
  const { width, height, size = 'md', compact = false } = opts;
  const minSide = Math.min(width, height);
  const roomPx = compact ? Math.min(0.15 * width, 0.22 * minSide) : Math.max(0.15 * width, 0.25 * minSide);
  const fullChars = longestValueLength(values.map(v => withUnit(v.number, v.unit)));
  return fitValues(
    values, size, width > 0 && height > 0,
    chars => (tileFitCqw(chars) / 100) * width,
    roomPx,
    TILE_VALUE_FLOOR_REM,
    TILE_VALUE_MAX_REM,
    tileValueFontSize(fullChars, size, compact),
  );
}

/** Fit a `gauges` block's values to its measured ring. */
export function fitGaugeValues(values: readonly ValueText[], opts: GaugeFitOptions): ValueFit {
  const { width, height, size = 'md', stroke = 10 } = opts;
  const minSide = Math.min(width, height);
  const fullChars = longestValueLength(values.map(v => withUnit(v.number, v.unit)));
  return fitValues(
    values, size, width > 0 && height > 0,
    chars => (gaugeFitCqmin(chars, stroke) / 100) * minSide,
    0.24 * minSide,
    GAUGE_VALUE_FLOOR_REM,
    GAUGE_VALUE_MAX_REM,
    gaugeValueFontSize(fullChars, size, stroke),
  );
}

const oneOf = <T extends string>(raw: unknown, values: readonly T[], where: string, key: string): Validated<T | undefined> => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
    return fail(`${where}: "${key}" must be one of ${values.join(', ')}`);
  }
  return { ok: true, value: raw as T };
};

export interface BlockSizing {
  size?: BlockSize;
  minItemWidth?: MinItemWidth;
  columns?: number;
}

/** Validate a block's `size`, `minItemWidth` and `columns`. */
export function validateBlockSizing(raw: Record<string, unknown>, where: string): Validated<BlockSizing> {
  const size = oneOf(raw.size, BLOCK_SIZES, where, 'size');
  if (!size.ok) return size;
  const minItemWidth = oneOf(raw.minItemWidth, MIN_ITEM_WIDTHS, where, 'minItemWidth');
  if (!minItemWidth.ok) return minItemWidth;
  let columns: number | undefined;
  if (raw.columns !== undefined) {
    if (typeof raw.columns !== 'number' || !Number.isInteger(raw.columns) || raw.columns < 1 || raw.columns > 6) {
      return fail(`${where}: "columns" must be a whole number from 1 to 6`);
    }
    columns = raw.columns;
  }
  return { ok: true, value: { ...(size.value ? { size: size.value } : {}), ...(minItemWidth.value ? { minItemWidth: minItemWidth.value } : {}), ...(columns !== undefined ? { columns } : {}) } };
}

/** Validate an optional item `emphasis`. */
export const validateEmphasis = (raw: unknown, where: string): Validated<Emphasis | undefined> =>
  oneOf(raw, EMPHASES, where, 'emphasis');

/** Validate an optional item `decimals` (0-3). */
export function validateDecimals(raw: unknown, where: string): Validated<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 3) {
    return fail(`${where}: "decimals" must be a whole number from 0 to 3`);
  }
  return { ok: true, value: raw };
}

/** Validate an optional ring `thickness`. */
export const validateGaugeThickness = (raw: unknown, where: string): Validated<GaugeThickness | undefined> =>
  oneOf(raw, GAUGE_THICKNESSES, where, 'thickness');

/** Validate the widget-level `density`. */
export const validateDensity = (raw: unknown): Validated<Density | undefined> =>
  oneOf(raw, DENSITIES, 'spec', 'density');
