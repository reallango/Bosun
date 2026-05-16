export type WidgetCategory = 'system' | 'docker' | 'gpu' | 'ai' | 'network' | 'utility' | 'advanced';

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
}

export interface Widget {
  id: string;
  dashboard_id: string;
  widget_type: string;
  server_id: string;
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