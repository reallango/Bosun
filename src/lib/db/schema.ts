export interface DBServer {
  id: string;
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string | null;
  os_type: string | null;
  os_version: string | null;
  os_codename: string | null;
  kernel_version: string | null;
  notes: string | null;
  is_online: number;
  last_seen: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  total_ram_mb: number | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface DBSSHKey {
  id: string;
  name: string;
  public_key: string;
  private_key_enc: string;
  passphrase_enc: string | null;
  fingerprint: string;
  key_type: string;
  created_at: string;
  updated_at: string;
}

export interface DBDashboard {
  id: string;
  name: string;
  type: 'home' | 'server' | 'custom';
  server_id: string | null;
  sort_order: number;
  icon: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface DBWidget {
  id: string;
  dashboard_id: string;
  widget_type: string;
  server_id: string;
  title_override: string | null;
  config: string;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  grid_min_w: number;
  grid_min_h: number;
  created_at: string;
  updated_at: string;
}

export interface DBUser {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  password_hash: string;
  role: 'admin' | 'operator' | 'viewer';
  totp_secret: string | null;
  totp_enabled: number;
  preferences: string;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBAuditLog {
  id: string;
  user_id: string | null;
  server_id: string | null;
  action: string;
  category: string;
  details: string | null;
  status: 'success' | 'failure' | 'pending' | 'cancelled';
  ip_address: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface DBAppConfig {
  key: string;
  value: string | null;
  description: string | null;
  updated_at: string;
}

export interface DBSession {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
}

export interface DBAlertRule {
  id: string;
  name: string;
  description: string | null;
  server_id: string | null;
  metric: string;
  condition: string;
  severity: 'info' | 'warning' | 'critical';
  channels: string;
  channel_config: string;
  cooldown_sec: number;
  enabled: number;
  last_triggered: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
}

export interface DBNotification {
  id: string;
  alert_rule_id: string | null;
  server_id: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  is_read: number;
  is_dismissed: number;
  delivered_via: string;
  created_at: string;
}

export interface DBNotificationChannel {
  id: string;
  name: string;
  type: 'in_app' | 'email' | 'webhook';
  config: string;
  enabled: number;
  test_status: string | null;
  tested_at: string | null;
  created_at: string;
  updated_at: string;
}