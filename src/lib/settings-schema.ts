export type SettingType = 'string' | 'number' | 'boolean';

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  description: string;
  options?: string[];
}

/**
 * Whitelist of `app_config` keys that may be read and edited from the Database
 * settings page. Any key not listed here is rejected by the settings API, which
 * keeps credentials and operational data (servers, SSH keys) out of reach.
 */
export const EDITABLE_SETTINGS: SettingDef[] = [
  { key: 'app.theme', label: 'Theme', type: 'string', description: 'Default UI theme', options: ['light', 'dark', 'system'] },
  { key: 'app.timezone', label: 'Timezone', type: 'string', description: 'Default timezone' },
  { key: 'app.date_format', label: 'Date format', type: 'string', description: 'Default date format' },
  { key: 'app.refresh_interval', label: 'Widget refresh interval (s)', type: 'number', description: 'Default widget refresh interval in seconds' },
  { key: 'ssh.timeout', label: 'SSH timeout (s)', type: 'number', description: 'SSH connection timeout in seconds' },
  { key: 'ssh.keepalive_interval', label: 'SSH keepalive interval (s)', type: 'number', description: 'SSH keepalive interval in seconds' },
  { key: 'alerts.enabled', label: 'Alerts enabled', type: 'boolean', description: 'Whether the alerting system is enabled' },
  { key: 'alerts.check_interval', label: 'Alert check interval (s)', type: 'number', description: 'Alert check interval in seconds' },
  { key: 'cleanup.audit_log_days', label: 'Audit log retention (days)', type: 'number', description: 'Days to keep audit log entries' },
  { key: 'cleanup.notification_days', label: 'Notification retention (days)', type: 'number', description: 'Days to keep notifications' },
  { key: 'cleanup.session_days', label: 'Session retention (days)', type: 'number', description: 'Days to keep expired sessions' },
  { key: 'health.check_interval_sec', label: 'Health check interval (s)', type: 'number', description: 'Server health check interval in seconds' },
];

export const EDITABLE_SETTING_KEYS = EDITABLE_SETTINGS.map(s => s.key);
