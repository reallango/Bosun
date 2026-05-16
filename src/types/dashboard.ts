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

export interface LayoutItem {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}