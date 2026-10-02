export type WidgetCategory = 'system' | 'docker' | 'gpu' | 'ai' | 'network' | 'utility' | 'advanced' | 'custom';
export type WidgetStorageMode = 'latest_ttl' | 'change_only';

/** Field types a custom widget can declare in its `config_schema`. */
export type WidgetConfigFieldType = 'string' | 'number' | 'boolean' | 'select';

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
  // Custom (database-defined) widget metadata. Built-ins leave these unset.
  isCustom?: boolean;
  /** When false the widget is always served live and never cached in the DB. */
  useDatabase?: boolean;
  supportsLinux?: boolean;
  supportsWindows?: boolean;
  /** Declarative form fields rendered in the widget settings dialog. */
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