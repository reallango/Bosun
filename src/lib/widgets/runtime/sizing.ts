/**
 * Bounded sizing keys for widget authors: how large a block's numbers are, how many items share a row and how thick a
 * ring is. Every key maps to a fixed token-based class or a CSS expression in core; a package can never inject CSS.
 * The fit helpers turn the length of a rendered value into a font size that keeps it inside its tile or ring. Pure
 * (no I/O), so the calculation and the validation can be tested on their own.
 */
import { fail, type Validated } from './spec-util';

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

/** The widest font (in cqw) at which `chars` characters still fit a tile. */
export const tileFitCqw = (chars: number): number => TILE_FIT_CQW / Math.max(1, chars);

/** The widest font (in cqmin) at which `chars` characters still fit inside a ring with this stroke. */
export const gaugeFitCqmin = (chars: number, stroke = 10): number =>
  (GAUGE_FIT_CQMIN * (100 - 2 * stroke) / 80) / Math.max(1, chars);

const rounded = (n: number): string => String(Number(n.toFixed(2)));

/** CSS font-size of a tile's value: it follows the card, but never grows past what the value's length allows. */
export function tileValueFontSize(chars: number, size: BlockSize = 'md', compact = false): string {
  const room = compact ? 'min(15cqw,22cqmin)' : 'max(15cqw,25cqmin)';
  return `calc(${SIZE_SCALE[size]} * clamp(0.85rem, min(${room}, calc(${rounded(tileFitCqw(chars))}cqw)), 6rem))`;
}

/** CSS font-size of the value inside a ring: a share of the ring's inner circle, shortened for a long value. */
export function gaugeValueFontSize(chars: number, size: BlockSize = 'md', stroke = 10): string {
  return `calc(${SIZE_SCALE[size]} * clamp(0.45rem, min(24cqmin, calc(${rounded(gaugeFitCqmin(chars, stroke))}cqmin)), 3.5rem))`;
}

/** CSS font-size of a block's label, scaled with its value. */
export function labelFontSize(size: BlockSize): string {
  return `calc(${SIZE_SCALE[size]} * clamp(0.85rem, max(3.4cqw,5cqmin), 1.1rem))`;
}

/** CSS font-size of the label inside a ring, scaled with the value. */
export function gaugeLabelFontSize(size: BlockSize): string {
  return `calc(${SIZE_SCALE[size]} * clamp(0.75rem,15cqmin,1rem))`;
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
