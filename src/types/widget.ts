import type { WidgetLayouts } from './dashboard';

export type WidgetCategory = 'system' | 'docker' | 'gpu' | 'ai' | 'network' | 'utility' | 'advanced' | 'custom';
export type WidgetStorageMode = 'latest_ttl' | 'change_only';

/** Field types a widget can declare in its config schema. */
export type WidgetConfigFieldType = 'string' | 'number' | 'boolean' | 'select';

/** One setting rendered in the widget settings dialog, stored in widgets.config. */
export interface WidgetConfigField {
  key: string;
  label: string;
  type: WidgetConfigFieldType;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  options?: string[];
}

export interface WidgetDefinition {
  type: string;
  displayName: string;
  description: string;
  icon: string;
  category: WidgetCategory;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  maxSize?: { w: number; h: number };
  refreshInterval: number;
  supportsStream?: boolean;
  // Background polling options
  backgroundPollable?: boolean;
  defaultPollInterval?: number;  // seconds
  defaultTTL?: number;        // seconds
  storageMode?: WidgetStorageMode;
  /** Database-defined (custom_widgets) rather than compiled into the registry. */
  isCustom?: boolean;
  /** Platform support; both default to true. */
  supportsLinux?: boolean;
  supportsWindows?: boolean;
  /** Declarative settings rendered in the widget settings dialog. */
  configSchema?: WidgetConfigField[];
}

export interface Widget {
  id: string;
  dashboard_id: string;
  widget_type: string;
  server_id: string;
  server_name?: string;
  server_host?: string;
  title_override: string | null;
  config: Record<string, unknown>;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  grid_min_w: number;
  grid_min_h: number;
  /** Per-breakpoint layouts other than lg (lg lives in grid_*). */
  layouts?: WidgetLayouts;
  created_at: string;
  updated_at: string;
}

export interface WidgetCreateInput {
  widget_type: string;
  server_id: string;
  config?: Record<string, unknown>;
  title_override?: string;
  grid_x?: number;
  grid_y?: number;
  grid_w?: number;
  grid_h?: number;
}

export interface WidgetProps {
  widgetId: string;
  serverId: string;
  serverName: string;
  config: Record<string, unknown>;
  data: unknown;
  isLoading: boolean;
  error: string | null;
  onConfigChange: (newConfig: Record<string, unknown>) => void;
  onRefresh: () => void;
}

export interface WidgetDataResponse {
  data: unknown;
  cachedAt?: string;
  error?: string;
}