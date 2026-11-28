import { lookMinSize, type LooksSpec } from '@/lib/widgets/runtime/looks';

/**
 * A widget instance stores its package's `min_size` when it is added. A package upgrade can lower that minimum, but
 * the copy on the instance would keep the old, larger floor. These helpers lower the stored minimum of existing
 * instances to the package's new one. They never raise it: a package that needs more room must not shrink a layout
 * someone arranged.
 */
export interface MinSize {
  w: number;
  h: number;
}

export interface MinSizeRow {
  id: string;
  widget_type: string;
  grid_min_w: number;
  grid_min_h: number;
  /** The instance's settings, as JSON; its `look` may ask for a floor of its own. */
  config?: string | null;
}

/** A `custom_widgets.min_size` value; the installer's 4x4 is the fallback, like the column itself. */
export function parseMinSize(raw: unknown): MinSize {
  try {
    const value = JSON.parse(String(raw ?? ''));
    if (value && Number.isFinite(value.w) && Number.isFinite(value.h)) {
      return { w: Math.round(value.w), h: Math.round(value.h) };
    }
  } catch {
    // An unreadable value falls back to the same default the column uses.
  }
  return { w: 4, h: 4 };
}

/** The look an instance has selected, from its stored settings (none when they are unreadable). */
function selectedLook(row: MinSizeRow): string | undefined {
  try {
    const config = JSON.parse(String(row.config ?? '{}'));
    return config && typeof config.look === 'string' ? config.look : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One UPDATE per instance whose stored minimum is above the floor that applies to it; unchanged instances are left
 * alone. The floor is the selected look's `min_size` when it has one (the settings route keeps an instance at that
 * floor, see applyLookMinSize), and the package's own minimum otherwise.
 */
export function minSizeStatements(
  rows: MinSizeRow[],
  declared: Map<string, MinSize>,
  looks?: Map<string, LooksSpec | undefined>,
): { sql: string; params: (string | number)[] }[] {
  const statements: { sql: string; params: (string | number)[] }[] = [];
  for (const row of rows) {
    const min = declared.get(row.widget_type);
    if (!min) continue;
    const floor = lookMinSize(looks?.get(row.widget_type), selectedLook(row)) ?? min;
    const w = Math.min(row.grid_min_w, floor.w);
    const h = Math.min(row.grid_min_h, floor.h);
    if (w === row.grid_min_w && h === row.grid_min_h) continue;
    statements.push({ sql: 'UPDATE widgets SET grid_min_w = ?, grid_min_h = ? WHERE id = ?', params: [w, h, row.id] });
  }
  return statements;
}

/** The stored size of an instance, as the settings route reads it. */
export interface InstanceSizeState {
  grid_min_w: number;
  grid_min_h: number;
  grid_w: number;
  grid_h: number;
}

/**
 * The size changes a look asks for when a person switches to it: the instance's floor follows the look's `min_size`
 * (lowered or raised), and the current size grows when the new floor no longer fits. Null when nothing changes.
 */
export function applyLookMinSize(current: InstanceSizeState, min: MinSize | null): Partial<InstanceSizeState> | null {
  if (!min) return null;
  const w = Math.max(1, Math.round(min.w));
  const h = Math.max(1, Math.round(min.h));
  const grid_w = Math.max(current.grid_w, w);
  const grid_h = Math.max(current.grid_h, h);
  if (current.grid_min_w === w && current.grid_min_h === h && grid_w === current.grid_w && grid_h === current.grid_h) return null;
  return { grid_min_w: w, grid_min_h: h, grid_w, grid_h };
}
