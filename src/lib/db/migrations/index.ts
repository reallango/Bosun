import { rqlite } from '@/lib/db/rqlite-client';


// ---- Migration 001: Core Tables ----
const MIGRATION_001: string[] = [
    // SSH Keys
    `CREATE TABLE IF NOT EXISTS ssh_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_key_enc TEXT NOT NULL,
        passphrase_enc TEXT,
        fingerprint TEXT NOT NULL,
        key_type TEXT DEFAULT 'ed25519',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Servers
    `CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
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
    )`,

    // Dashboards
    `CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        icon TEXT,
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Widgets
    `CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
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
    )`,

    // App Config
    `CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        description TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Users
    `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        totp_secret TEXT,
        totp_enabled INTEGER DEFAULT 0,
        preferences TEXT DEFAULT '{}',
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Audit Log
    `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        server_id TEXT REFERENCES servers(id),
        action TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        details TEXT,
        status TEXT,
        ip_address TEXT,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Alert Rules
    `CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        server_id TEXT REFERENCES servers(id),
        metric TEXT NOT NULL,
        condition TEXT NOT NULL,
        severity TEXT DEFAULT 'warning',
        channels TEXT NOT NULL DEFAULT '["in_app"]',
        channel_config TEXT DEFAULT '{}',
        cooldown_sec INTEGER DEFAULT 300,
        enabled INTEGER DEFAULT 1,
        last_triggered DATETIME,
        trigger_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Notifications
    `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        alert_rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
        server_id TEXT REFERENCES servers(id),
        severity TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        is_dismissed INTEGER DEFAULT 0,
        delivered_via TEXT DEFAULT '["in_app"]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Notification Channels
    `CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER DEFAULT 1,
        test_status TEXT,
        tested_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Sessions
    `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON widgets(dashboard_id)`,
    `CREATE INDEX IF NOT EXISTS idx_widgets_server ON widgets(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboards_server ON dashboards(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboards_type ON dashboards(type)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_rules_server ON alert_rules(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
];

// ---- Migration 002: Default Data ----
const MIGRATION_002: string[] = [
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.setup_complete', 'false', 'Whether initial setup has been completed')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.theme', 'dark', 'Default UI theme')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.timezone', 'UTC', 'Default timezone')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.date_format', 'YYYY-MM-DD HH:mm:ss', 'Default date format')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.refresh_interval', '5', 'Default widget refresh interval in seconds')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('ssh.timeout', '10', 'SSH connection timeout in seconds')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('ssh.keepalive_interval', '30', 'SSH keepalive interval in seconds')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('alerts.enabled', 'true', 'Whether alerting system is enabled')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('alerts.check_interval', '60', 'Alert check interval in seconds')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('cleanup.audit_log_days', '90', 'Days to keep audit log entries')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('cleanup.notification_days', '30', 'Days to keep notifications')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('cleanup.session_days', '7', 'Days to keep expired sessions')`,
    `INSERT OR IGNORE INTO dashboards (id, name, type, sort_order, is_default) VALUES ('home', 'Home', 'home', 0, 1)`,
];

// ---- Migration 003: Widget Polling ----
const MIGRATION_003: string[] = [
    // Widget polling config (per-widget polling settings per server)
    `CREATE TABLE IF NOT EXISTS widget_polling_config (
        id TEXT PRIMARY KEY,
        widget_type TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        poll_interval_sec INTEGER,
        ttl_sec INTEGER,
        storage_mode TEXT DEFAULT 'latest_ttl',
        enabled INTEGER DEFAULT 1,
        last_polled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(widget_type, server_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wpc_server_type ON widget_polling_config(server_id, widget_type)`,

    // Widget data cache
    `CREATE TABLE IF NOT EXISTS widget_data_cache (
        id TEXT PRIMARY KEY,
        widget_type TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        data_hash TEXT,
        storage_mode TEXT DEFAULT 'latest_ttl',
        collected_at DATETIME NOT NULL,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wdc_server_type ON widget_data_cache(server_id, widget_type)`,
    `CREATE INDEX IF NOT EXISTS idx_wdc_expires ON widget_data_cache(expires_at)`,
];
const MIGRATION_004: string[] = [
    // Add display_name to widgets (custom display name for each instance)
    `ALTER TABLE widgets ADD COLUMN display_name TEXT`,
];

// Migration 005: Add widget_id to polling config for per-widget settings
const MIGRATION_005: string[] = [
    // Add widget_id column (nullable for backwards compatibility)
    `ALTER TABLE widget_polling_config ADD COLUMN widget_id TEXT REFERENCES widgets(id) ON DELETE CASCADE`,
    // Drop old unique constraint
    `DROP INDEX IF EXISTS idx_wpc_server_type`,
    // Add unique constraint that allows either widget_id or legacy (widget_type, server_id) combo
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_wpc_widget_id ON widget_polling_config(widget_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wpc_type_server ON widget_polling_config(widget_type, server_id)`,
];

// Migration 006: Seed the health check interval config read by the health checker
const MIGRATION_006: string[] = [
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('health.check_interval_sec', '30', 'Server health check interval in seconds')`,
];

// Migration 007: Platform flag so code paths can branch on Linux vs Windows
const MIGRATION_007: string[] = [
    `ALTER TABLE servers ADD COLUMN platform TEXT DEFAULT 'linux'`,
];

// Migration 008: User-defined ("custom") widgets.
//
// A custom widget is a widget type that lives in the database rather than in
// the compiled `widgetRegistry`, so operators can add/configure widget types
// without a rebuild. The row describes the type; individual instances are
// ordinary `widgets` rows referencing it by `widget_type`.
const MIGRATION_008: string[] = [
    `CREATE TABLE IF NOT EXISTS custom_widgets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        icon TEXT DEFAULT 'puzzle',
        category TEXT DEFAULT 'custom',
        default_size TEXT DEFAULT '{"w":8,"h":6}',
        min_size TEXT DEFAULT '{"w":4,"h":4}',
        refresh_interval INTEGER DEFAULT 30,
        use_database INTEGER DEFAULT 1,
        supports_linux INTEGER DEFAULT 1,
        supports_windows INTEGER DEFAULT 1,
        default_poll_interval INTEGER DEFAULT 30,
        default_ttl INTEGER DEFAULT 1800,
        storage_mode TEXT DEFAULT 'latest_ttl',
        config_schema TEXT DEFAULT '[]',
        enabled INTEGER DEFAULT 1,
        builtin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_custom_widgets_type ON custom_widgets(type)`,
    // Ollama status is the first widget migrated out of the compiled registry
    // into a database-defined custom widget. It runs on both platforms, uses
    // the database cache, and exposes an optional base URL.
    `INSERT OR IGNORE INTO custom_widgets
        (id, type, display_name, description, icon, category, default_size, min_size, refresh_interval,
         use_database, supports_linux, supports_windows, default_poll_interval, default_ttl, storage_mode, config_schema, enabled, builtin)
     VALUES
        ('custom-ollama-status', 'ollama_status', 'Ollama Status',
         'Ollama runtime: available and loaded models, memory usage and CPU/GPU split',
         'bot', 'ai', '{"w":8,"h":8}', '{"w":6,"h":5}', 10,
         1, 1, 1, 10, 1800, 'latest_ttl',
         '[{"key":"baseUrl","label":"Ollama base URL","type":"string","placeholder":"http://localhost:11434","default":"http://localhost:11434","description":"Ollama API endpoint on the host"}]',
         1, 1)`,
];

// Migration 009: Widget cache lookup indexes.
//
// The widget data route's cache read filters on (widget_type, server_id) and
// orders by collected_at; the poller's change_only hash check does the same.
// The previous single-column indexes could not serve that access path, so each
// dashboard load scanned the whole cache table.
const MIGRATION_009: string[] = [
    `CREATE INDEX IF NOT EXISTS idx_wdc_type_server_collected ON widget_data_cache(widget_type, server_id, collected_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wpc_widget_type_server ON widget_polling_config(widget_type, server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_migrations_id ON migrations(id)`,
];

// Migration 010: Per-instance database-caching override.
//
// `custom_widgets.use_database` sets the type default, but an operator may want
// one instance to bypass the cache (e.g. a live command) while another keeps
// caching. The widget settings dialog writes this per-instance value; NULL means
// "inherit the type default".
const MIGRATION_010: string[] = [
    `ALTER TABLE widget_polling_config ADD COLUMN use_database INTEGER`,
];

// Migration 011: Wake-on-LAN target MAC address per server.
//
// The MAC is the one identifier needed to send a magic packet to an offline
// host, so it is stored on the server row (nullable - hosts without WoL or
// without a configured NIC simply leave it blank).
const MIGRATION_011: string[] = [
    `ALTER TABLE servers ADD COLUMN mac_address TEXT`,
];

// Migration 012: Wake-on-LAN "local server" settings.
//
// A magic packet must originate on the same L2 segment as the target, which the
// Bosun container usually is not. `wol.local_server_id` names a managed server
// (typically the Docker host) whose SSH credentials Bosun uses to run the WoL
// utility; `wol.use_local_server` toggles that path; `wol.remote_wol_installed`
// caches whether the utility was installed on that host so the wake route can
// offer an install instead of re-probing on every failure.
const MIGRATION_012: string[] = [
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.local_server_id', NULL, 'Server id whose host sends Wake-on-LAN packets on its own subnet')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.use_local_server', 'false', 'Send Wake-on-LAN via the local server instead of from the Bosun container')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.remote_wol_installed', 'false', 'Whether the Wake-on-LAN utility is installed on the local server')`,
];

// Migration registry
const migrations: Record<string, string[]> = {
    '001': MIGRATION_001,
    '002': MIGRATION_002,
    '003': MIGRATION_003,
    '004': MIGRATION_004,
    '005': MIGRATION_005,
    '006': MIGRATION_006,
    '007': MIGRATION_007,
    '008': MIGRATION_008,
    '009': MIGRATION_009,
    '010': MIGRATION_010,
    '011': MIGRATION_011,
    '012': MIGRATION_012,
};

// All migration IDs this build expects to be applied, in order.
export const EXPECTED_MIGRATIONS: string[] = Object.keys(migrations).sort();

// The schema version is the highest expected migration ID (e.g. "006").
export const SCHEMA_VERSION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1] ?? '000';

// Tables the application expects to exist after all migrations have run.
export const CORE_TABLES: string[] = [
    'ssh_keys',
    'servers',
    'dashboards',
    'widgets',
    'app_config',
    'users',
    'audit_log',
    'alert_rules',
    'notifications',
    'notification_channels',
    'sessions',
    'widget_polling_config',
    'widget_data_cache',
    'custom_widgets',
];

// Errors that mean a statement was already applied on a previous partial run,
// so retrying is safe and should not be treated as a failure.
function isAlreadyAppliedError(err: unknown): boolean {
    const msg = String(err).toLowerCase();
    return msg.includes('duplicate column name') || msg.includes('already exists');
}

export async function runMigrations(): Promise<void> {
    console.log('Running database migrations...');

    try {
        await rqlite.execute("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    } catch (e) {
        console.log('Migrations table may already exist');
    }

    for (const [id, statements] of Object.entries(migrations)) {
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

        console.log(`Applying migration ${id} (${statements.length} statements)...`);

        // Execute each statement - statements is already an array, no parsing needed
        let failCount = 0;
        for (const stmt of statements) {
            try {
                console.log(`  Executing: ${stmt.substring(0, 70).replace(/\n/g, ' ')}...`);
                await rqlite.execute(stmt);
            } catch (e) {
                if (isAlreadyAppliedError(e)) {
                    console.log(`  Already applied, skipping: ${stmt.substring(0, 70).replace(/\n/g, ' ')}...`);
                    continue;
                }
                failCount++;
                console.error(`  FAILED: ${stmt.substring(0, 70).replace(/\n/g, ' ')}...`);
                console.error(`  Error: ${e}`);
            }
        }

        // Only record a migration once every statement has succeeded. A partially
        // applied migration stays unrecorded so it is retried (and reported as
        // pending) rather than being silently marked as done.
        if (failCount > 0) {
            console.error(`Migration ${id}: ${failCount}/${statements.length} statements failed - NOT recording`);
            continue;
        }

        try {
            await rqlite.execute("INSERT INTO migrations (id, name) VALUES (?, ?)", [id, `migration_${id}`]);
            console.log(`Migration ${id} recorded`);
        } catch (e) {
            console.error(`Failed to record migration ${id}:`, e);
        }
    }

    console.log('Migrations complete');
}

export interface MigrationStatus {
    expected: string[];
    applied: string[];
    /** Expected migrations that have not been applied yet. */
    missing: string[];
    /** Applied migrations this build does not know about (e.g. after a downgrade). */
    pending: string[];
    schemaVersion: string;
    upToDate: boolean;
}

/** IDs recorded in the `migrations` table, in application order. */
export async function getAppliedMigrations(): Promise<string[]> {
    const result = await rqlite.query("SELECT id FROM migrations ORDER BY id");
    return result.values.map(row => String(row[0]));
}

/** Compare applied migrations against what this build expects. */
export async function getMigrationStatus(): Promise<MigrationStatus> {
    const applied = await getAppliedMigrations();
    const appliedSet = new Set(applied);
    const expectedSet = new Set(EXPECTED_MIGRATIONS);

    const missing = EXPECTED_MIGRATIONS.filter(id => !appliedSet.has(id));
    const pending = applied.filter(id => !expectedSet.has(id));
    const upToDate = missing.length === 0;

    return {
        expected: EXPECTED_MIGRATIONS,
        applied,
        missing,
        pending,
        schemaVersion: applied.length ? applied[applied.length - 1] : '000',
        upToDate,
    };
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
        "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        [key, value]
    );
}
