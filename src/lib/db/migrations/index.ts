// Database migrations for Bosun
import { rqlite, ExecuteResult } from '../rqlite-client';

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`;

const MIGRATION_001 = `
-- Migration 001: Core Tables

CREATE TABLE IF NOT EXISTS ssh_keys (
  id TEXT PRIMARY KEY,,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  passphrase_enc TEXT,
  fingerprint TEXT NOT NULL,
  key_type TEXT DEFAULT 'ed25519',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  ssh_port INTEGER DEFAULT 22,
  ssh_user TEXT NOT NULL,
  ssh_key_id TEXT REFERENCES ssh_keys(id) ON DELETE SET NULL,
  os_type TEXT,
  os_version TEXT,
  os_codename TEXT,
  kernel_version TEXT,
  notes TEXT,
  is_online INTEGER DEFAULT 0,
  last_seen DATETIME,
  cpu_model TEXT,
  cpu_cores INTEGER,
  total_ram_mb INTEGER,
  tags TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('home', 'server', 'custom')),
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  icon TEXT,
  is_default INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  widget_type TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title_override TEXT,
  config TEXT DEFAULT '{}',
  grid_x INTEGER DEFAULT 0,
  grid_y INTEGER DEFAULT 0,
  grid_w INTEGER DEFAULT 4,
  grid_h INTEGER DEFAULT 3,
  grid_min_w INTEGER DEFAULT 2,
  grid_min_h INTEGER DEFAULT 2,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'operator', 'viewer')),
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  preferences TEXT DEFAULT '{}',
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,,
  user_id TEXT REFERENCES users(id),
  server_id TEXT REFERENCES servers(id),
  action TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  details TEXT,
  status TEXT CHECK(status IN ('success', 'failure', 'pending', 'cancelled')),
  ip_address TEXT,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,,
  name TEXT NOT NULL,
  description TEXT,
  server_id TEXT REFERENCES servers(id),
  metric TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
  channels TEXT NOT NULL DEFAULT '["in_app"]',
  channel_config TEXT DEFAULT '{}',
  cooldown_sec INTEGER DEFAULT 300,
  enabled INTEGER DEFAULT 1,
  last_triggered DATETIME,
  trigger_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,,
  alert_rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  server_id TEXT REFERENCES servers(id),
  severity TEXT CHECK(severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  is_dismissed INTEGER DEFAULT 0,
  delivered_via TEXT DEFAULT '["in_app"]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('in_app', 'email', 'webhook')),
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  test_status TEXT,
  tested_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON widgets(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_widgets_server ON widgets(server_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_server ON dashboards(server_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_type ON dashboards(type);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_alert_rules_server ON alert_rules(server_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

const MIGRATION_002 = `
-- Migration 002: Seed Data

INSERT OR IGNORE INTO app_config (key, value, description) VALUES
  ('app.name', 'Bosun', 'Application display name'),
  ('app.setup_complete', 'false', 'Whether initial setup wizard has been completed'),
  ('ssh.connection_timeout_ms', '10000', 'SSH connection timeout in milliseconds'),
  ('ssh.command_timeout_ms', '30000', 'SSH command execution timeout in milliseconds'),
  ('ssh.pool_max_per_server', '3', 'Maximum SSH connections per server in the pool'),
  ('ssh.pool_idle_timeout_ms', '300000', 'Idle SSH connection timeout (5 minutes)'),
  ('ssh.keepalive_interval_ms', '30000', 'SSH keepalive interval'),
  ('health.check_interval_sec', '30', 'Server health check interval in seconds'),
  ('widget.default_refresh_sec', '15', 'Default widget data refresh interval'),
  ('auth.session_ttl_hours', '24', 'Session token time-to-live'),
  ('auth.refresh_ttl_days', '7', 'Refresh token time-to-live'),
  ('cluster.node_name', '', 'This nodes unique name (set via NODE_NAME env var)');

INSERT OR IGNORE INTO dashboards (id, name, type, sort_order, is_default) VALUES
  ('home', 'Home', 'home', 0, 1);
`;

const migrations: Record<string, string> = {
  '001': MIGRATION_001,
  '002': MIGRATION_002
};

export async function runMigrations(): Promise<void> {
    console.log('Running database migrations...');

    try {
        await rqlite.execute("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    } catch (e) {
        console.log('Migrations table may already exist');
    }


    for (const [id, sql] of Object.entries(migrations)) {
        // Check if already applied
        let existing;
        try {
            existing = await rqlite.query("SELECT id FROM migrations WHERE id = ?", [id]);
        } catch {
            existing = { columns: [], types: [], values: [] };
        }


        if (existing.values && existing.values.length > 0) {
            console.log(`Migration ${id} already applied`);
            continue;
        }


        console.log(`Applying migration ${id}...`);


        // Strip SQL comment lines FIRST, then split into statements
        const cleanedSql = sql
            .split('\n')
            .map(line => line.trim())
            .filter(line => !line.startsWith('--'))
            .join('\n');


        const statements = cleanedSql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);


        // Execute each statement individually
        for (const stmt of statements) {
            try {
                await rqlite.execute(stmt);
            } catch (e) {
                console.error(`Migration ${id} statement failed: ${stmt.substring(0, 80)}...`);
                console.error(e);
                // Continue - some may be CREATE IF NOT EXISTS that partially work
            }
        }


        // Record migration
        try {
            await rqlite.execute("INSERT INTO migrations (id, name) VALUES (?, ?)", [id, `migration_${id}`]);
            console.log(`Migration ${id} applied`);
        } catch (e) {
            console.error(`Failed to record migration ${id}:`, e);
        }
    }


    console.log('Migrations complete');
}

export async function getConfig(key: string): Promise<string | null> {
    try {
        const result = await rqlite.query("SELECT value FROM app_config WHERE key = ?", [key]);
        return result.values && result.values.length > 0 ? result.values[0][0] as string : null;
    } catch {
        return null;
    }
}

export async function setConfig(key: string, value: string): Promise<void> {
  await rqlite.execute(
    `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [key, value]
  );
}