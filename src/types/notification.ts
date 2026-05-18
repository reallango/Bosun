export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface Notification {
  id: string;
  alert_rule_id?: string;
  server_id?: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  is_read: boolean;
  is_dismissed: boolean;
  delivered_via: 'in_app' | 'email' | 'webhook';
  created_at: string;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'in_app' | 'email' | 'webhook';
  config: {
    url?: string;
    email?: string;
    enabled?: boolean;
  };
  enabled: boolean;
  test_status?: string;
  tested_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  server_id?: string;
  metric: string;
  condition: string; // e.g., "cpu > 80"
  severity: NotificationSeverity;
  channels: string[]; // channel IDs
  cooldown_sec: number;
  enabled: boolean;
  last_triggered?: string;
  trigger_count: number;
  created_at: string;
  updated_at: string;
}