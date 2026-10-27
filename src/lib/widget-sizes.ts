import type { GridBreakpoint, GridRect, WidgetLayouts } from '@/types/dashboard';

// Size presets for widgets based on a 24-column grid with rowHeight=50

export interface SizePreset {
  id: string;
  name: string;
  gridW: number;
  gridH: number;
  description: string;
}

export const SIZE_PRESETS: SizePreset[] = [
  // Small sizes
  { id: 'tiny', name: 'Tiny', gridW: 3, gridH: 2, description: '3x2' },
  { id: 'small', name: 'Small', gridW: 4, gridH: 3, description: '4x3' },
  { id: 'medium-sm', name: 'Medium (S)', gridW: 6, gridH: 4, description: '6x4' },
  // Medium sizes
  { id: 'medium', name: 'Medium', gridW: 8, gridH: 5, description: '8x5' },
  { id: 'medium-lg', name: 'Medium (L)', gridW: 12, gridH: 6, description: '12x6' },
  // Wide sizes
  { id: 'wide-sm', name: 'Wide (S)', gridW: 12, gridH: 3, description: '12x3' },
  { id: 'wide', name: 'Wide', gridW: 16, gridH: 4, description: '16x4' },
  { id: 'wide-lg', name: 'Wide (L)', gridW: 20, gridH: 5, description: '20x5' },
  // Large sizes
  { id: 'large', name: 'Large', gridW: 12, gridH: 8, description: '12x8' },
  { id: 'large-xl', name: 'Large (XL)', gridW: 16, gridH: 10, description: '16x10' },
  // Full width
  { id: 'full', name: 'Full Width', gridW: 24, gridH: 6, description: '24x6' },
  { id: 'full-tall', name: 'Full (Tall)', gridW: 24, gridH: 12, description: '24x12' },
];

export const DEFAULT_SIZE_PRESET = SIZE_PRESETS[2]; // Medium (S) 6x4

// ---------------------------------------------------------------------------
// Responsive grid scheme
//
// Breakpoints are compared against the *grid container* width (not the
// viewport). `lg` keeps the historical 24-column semantics; wider screens get
// proportionally more columns so a 6-col widget stays roughly the same pixel
// width, narrower ones fewer. xs/xxs stack every widget full width.
//
//   bp    min width  cols  rowHeight  margin
//   xxl   2200       36    56         16
//   xl    1600       30    52         14
//   lg    1200       24    50         12
//   md     996       20    48         10
//   sm     768       12    48         10
//   xs     480        4    44          8   (stacked)
//   xxs      0        2    44          8   (stacked)
// ---------------------------------------------------------------------------


export const BASE_COLS = 24;

export const GRID_BREAKPOINTS: Record<GridBreakpoint, number> = {
  xxl: 2200,
  xl: 1600,
  lg: 1200,
  md: 996,
  sm: 768,
  xs: 480,
  xxs: 0,
};

export const GRID_COLS: Record<GridBreakpoint, number> = {
  xxl: 36,
  xl: 30,
  lg: 24,
  md: 20,
  sm: 12,
  xs: 4,
  xxs: 2,
};

export const GRID_ROW_HEIGHT: Record<GridBreakpoint, number> = {
  xxl: 56,
  xl: 52,
  lg: 50,
  md: 48,
  sm: 48,
  xs: 44,
  xxs: 44,
};

export const GRID_MARGIN: Record<GridBreakpoint, [number, number]> = {
  xxl: [16, 16],
  xl: [14, 14],
  lg: [12, 12],
  md: [10, 10],
  sm: [10, 10],
  xs: [8, 8],
  xxs: [8, 8],
};

/** Breakpoints where widgets are stacked in a single full-width column. */
export const STACKED_BREAKPOINTS: GridBreakpoint[] = ['xs', 'xxs'];

export interface LayoutSource {
  id: string;
  grid_x?: number | null;
  grid_y?: number | null;
  grid_w?: number | null;
  grid_h?: number | null;
  grid_min_w?: number | null;
  grid_min_h?: number | null;
  layouts?: WidgetLayouts | null;
}

export interface GridItem extends GridRect {
  i: string;
  minW?: number;
  minH?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

export function lgRect(w: LayoutSource): GridRect {
  return {
    x: Math.max(0, int(w.grid_x, 0)),
    y: Math.max(0, int(w.grid_y, 0)),
    w: clamp(int(w.grid_w, 4), 1, BASE_COLS),
    h: Math.max(1, int(w.grid_h, 3)),
  };
}

function scaleMin(min: number | null | undefined, cols: number) {
  if (!min || min <= 0) return undefined;
  return clamp(Math.round((min * cols) / BASE_COLS), 1, cols);
}

/** Clamp a stored rect so it fits the breakpoint's column count. */
function fitRect(r: GridRect, cols: number): GridRect {
  const w = clamp(int(r.w, 1), 1, cols);
  return {
    w,
    x: clamp(int(r.x, 0), 0, cols - w),
    y: Math.max(0, int(r.y, 0)),
    h: Math.max(1, int(r.h, 3)),
  };
}

/**
 * Layout for one breakpoint: saved per-breakpoint rect if present, otherwise
 * derived from lg (scaled horizontally; stacked full width on xs/xxs).
 */
export function layoutForBreakpoint(widgets: LayoutSource[], bp: GridBreakpoint): GridItem[] {
  const cols = GRID_COLS[bp];

  if (bp === 'lg') {
    return widgets.map(w => ({ i: w.id, ...fitRect(lgRect(w), cols), minW: scaleMin(w.grid_min_w, cols), minH: w.grid_min_h || undefined }));
  }

  if (STACKED_BREAKPOINTS.includes(bp)) {
    // Saved stacked layouts win; otherwise stack in lg reading order.
    const ordered = [...widgets].sort((a, b) => {
      const ra = lgRect(a);
      const rb = lgRect(b);
      return ra.y - rb.y || ra.x - rb.x;
    });
    let y = 0;
    return ordered.map(w => {
      const saved = w.layouts?.[bp];
      if (saved) return { i: w.id, ...fitRect(saved, cols) };
      const h = clamp(lgRect(w).h, Math.max(3, w.grid_min_h || 0), 12);
      const item = { i: w.id, x: 0, y, w: cols, h };
      y += h;
      return item;
    });
  }

  const factor = cols / BASE_COLS;
  return widgets.map(w => {
    const minW = scaleMin(w.grid_min_w, cols);
    const minH = w.grid_min_h || undefined;
    const saved = w.layouts?.[bp];
    if (saved) return { i: w.id, ...fitRect(saved, cols), minW, minH };
    const r = lgRect(w);
    const width = clamp(Math.round(r.w * factor), Math.min(cols, Math.max(2, minW ?? 0)), cols);
    const x = clamp(Math.round(r.x * factor), 0, cols - width);
    return { i: w.id, x, y: r.y, w: width, h: r.h, minW, minH };
  });
}

export function buildResponsiveLayouts(widgets: LayoutSource[]): Record<GridBreakpoint, GridItem[]> {
  const out = {} as Record<GridBreakpoint, GridItem[]>;
  (Object.keys(GRID_COLS) as GridBreakpoint[]).forEach(bp => {
    out[bp] = layoutForBreakpoint(widgets, bp);
  });
  return out;
}
