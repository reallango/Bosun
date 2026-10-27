export interface Dashboard {
  id: string;
  name: string;
  type: 'home' | 'server' | 'custom';
  server_id: string | null;
  sort_order: number;
  icon: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface DashboardCreateInput {
  name: string;
  icon?: string;
}

export interface DashboardUpdateInput {
  name?: string;
  sort_order?: number;
  icon?: string;
}

/** Grid breakpoints, widest first. `lg` is the canonical 24-column layout (widgets.grid_*). */
export const GRID_BREAKPOINT_NAMES = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs', 'xxs'] as const;
export type GridBreakpoint = (typeof GRID_BREAKPOINT_NAMES)[number];

export function isGridBreakpoint(value: unknown): value is GridBreakpoint {
  return typeof value === 'string' && (GRID_BREAKPOINT_NAMES as readonly string[]).includes(value);
}

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-breakpoint overrides stored in widgets.layouts (JSON). Never contains `lg`. */
export type WidgetLayouts = Partial<Record<GridBreakpoint, GridRect>>;

export interface LayoutItem extends GridRect {
  widgetId: string;
}

/** Body of PATCH /api/dashboards/[dashboardId]/layout. Missing breakpoint = `lg`. */
export interface LayoutUpdateRequest {
  breakpoint?: GridBreakpoint;
  layout: LayoutItem[];
}
