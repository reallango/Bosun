/**
 * Versioned schema management.
 *
 * The schema is a list of numbered migrations. Version 1 is a complete
 * baseline (the pre-2.0 incremental migrations 001-007 were folded into it).
 * Applied versions are recorded in `schema_migrations`; each migration runs as
 * one atomic rqlite transaction together with its bookkeeping row, so a
 * migration is either fully applied or not at all.
 *
 * Databases created by the old migration system (a `migrations` table with
 * string ids) are not upgraded in place. Start with an empty data volume, or
 * set BOSUN_DB_RESET=1 once to drop every table and re-create the schema.
 */
import { rqlite } from '@/lib/db/rqlite-client';

export interface Migration {
    version: number;
    name: string;
    statements: string[];
}

// ---- Version 1: baseline ----
const BASELINE: string[] = [
    `CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        description TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        preferences TEXT NOT NULL DEFAULT '{}',
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS ssh_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_key_enc TEXT NOT NULL,
        passphrase_enc TEXT,
        fingerprint TEXT NOT NULL,
        key_type TEXT NOT NULL DEFAULT 'ed25519',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Monitored hosts. Polling settings live here: one persistent SSH session
    // and one batched collection command per host per poll.
    `CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        hostname TEXT NOT NULL,
        ssh_port INTEGER NOT NULL DEFAULT 22,
        ssh_user TEXT NOT NULL,
        ssh_key_id TEXT REFERENCES ssh_keys(id) ON DELETE SET NULL,
        platform TEXT NOT NULL DEFAULT 'linux' CHECK (platform IN ('linux', 'windows')),
        os_type TEXT,
        os_version TEXT,
        os_codename TEXT,
        kernel_version TEXT,
        cpu_model TEXT,
        cpu_cores INTEGER,
        total_ram_mb INTEGER,
        notes TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        capabilities TEXT NOT NULL DEFAULT '{}',
        poll_enabled INTEGER NOT NULL DEFAULT 1,
        poll_interval_sec INTEGER NOT NULL DEFAULT 15,
        is_online INTEGER NOT NULL DEFAULT 0,
        last_seen DATETIME,
        last_error TEXT,
        host_key_fingerprint TEXT,
        poll_requested_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('home', 'server', 'custom')),
        server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        icon TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // grid_* is the lg layout; `layouts` holds the other breakpoints as JSON
    // ({"md":{"x":0,"y":0,"w":10,"h":6}, ...}).
    `CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        widget_type TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        title_override TEXT,
        display_name TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        grid_x INTEGER NOT NULL DEFAULT 0,
        grid_y INTEGER NOT NULL DEFAULT 0,
        grid_w INTEGER NOT NULL DEFAULT 4,
        grid_h INTEGER NOT NULL DEFAULT 3,
        grid_min_w INTEGER NOT NULL DEFAULT 2,
        grid_min_h INTEGER NOT NULL DEFAULT 2,
        layouts TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Latest collected data per host and section (cpu, memory, disks, gpu,
    // docker, ollama, ...). Written by the poller, read by widgets.
    `CREATE TABLE IF NOT EXISTS host_snapshots (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        section TEXT NOT NULL,
        data TEXT NOT NULL,
        data_hash TEXT,
        collected_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, section)
    )`,

    // Raw numeric samples (epoch seconds), kept for a short window.
    `CREATE TABLE IF NOT EXISTS metric_samples (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (server_id, metric, ts)
    )`,

    // Downsampled aggregates (resolution in seconds: 300 and 3600), maintained
    // incrementally by the poller on every sample.
    `CREATE TABLE IF NOT EXISTS metric_rollups (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        resolution INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        avg REAL NOT NULL,
        min REAL NOT NULL,
        max REAL NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (server_id, metric, resolution, bucket)
    )`,

    `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        details TEXT,
        status TEXT,
        ip_address TEXT,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        condition TEXT NOT NULL CHECK (condition IN ('gt', 'gte', 'lt', 'lte')),
        threshold REAL NOT NULL DEFAULT 0,
        severity TEXT NOT NULL DEFAULT 'warning',
        channels TEXT NOT NULL DEFAULT '["in_app"]',
        channel_config TEXT NOT NULL DEFAULT '{}',
        cooldown_sec INTEGER NOT NULL DEFAULT 300,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered DATETIME,
        trigger_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        alert_rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
        server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
        severity TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_dismissed INTEGER NOT NULL DEFAULT 0,
        delivered_via TEXT NOT NULL DEFAULT '["in_app"]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        test_status TEXT,
        tested_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON widgets(dashboard_id)`,
    `CREATE INDEX IF NOT EXISTS idx_widgets_server ON widgets(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboards_server ON dashboards(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dashboards_type ON dashboards(type)`,
    `CREATE INDEX IF NOT EXISTS idx_metric_samples_ts ON metric_samples(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_metric_rollups_bucket ON metric_rollups(resolution, bucket)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_rules_server ON alert_rules(server_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

    `INSERT OR IGNORE INTO dashboards (id, name, type, sort_order, is_default) VALUES ('home', 'Home', 'home', 0, 1)`,
];

/** Seeded `app_config` defaults: [key, value, description]. */
export const DEFAULT_CONFIG: [string, string, string][] = [
    ['app.setup_complete', 'false', 'Whether initial setup has been completed'],
    ['app.theme', 'dark', 'Default UI theme'],
    ['app.timezone', 'UTC', 'Default timezone'],
    ['app.date_format', 'YYYY-MM-DD HH:mm:ss', 'Default date format'],
    ['app.refresh_interval', '15', 'Default widget refresh interval in seconds'],
    ['ssh.timeout', '10', 'SSH connection timeout in seconds'],
    ['ssh.keepalive_interval', '30', 'SSH keepalive interval in seconds'],
    ['alerts.enabled', 'true', 'Whether alerting system is enabled'],
    ['alerts.check_interval', '60', 'Alert check interval in seconds'],
    ['cleanup.audit_log_days', '90', 'Days to keep audit log entries'],
    ['cleanup.notification_days', '30', 'Days to keep notifications'],
    ['cleanup.session_days', '7', 'Days to keep expired sessions'],
    ['poller.default_interval_sec', '15', 'Default host poll interval in seconds for new servers'],
    ['metrics.raw_retention_hours', '48', 'Hours to keep raw metric samples'],
    ['metrics.rollup_5m_retention_days', '30', 'Days to keep 5-minute metric rollups'],
    ['metrics.rollup_1h_retention_days', '400', 'Days to keep 1-hour metric rollups'],
];

// ---- Version 2: Wake-on-LAN and database-defined widget types (from dev) ----
const V2_WOL_AND_CUSTOM_WIDGETS: string[] = [
    // MAC address of the NIC to wake (nullable: hosts without WoL leave it blank).
    `ALTER TABLE servers ADD COLUMN mac_address TEXT`,
    // Set by "Check for updates"; the poller then runs the 6-hourly update probe once.
    `ALTER TABLE servers ADD COLUMN updates_requested_at INTEGER`,

    // A magic packet must originate on the target's L2 segment, which the Bosun
    // container usually is not. wol.local_server_id names a managed server
    // (typically the Docker host) that sends it with the `wakeonlan` utility.
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.local_server_id', NULL, 'Server id whose host sends Wake-on-LAN packets on its own subnet')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.use_local_server', 'false', 'Send Wake-on-LAN via the local server instead of from the Bosun container')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.remote_wol_installed', 'false', 'Whether the Wake-on-LAN utility is installed on the local server')`,

    // Widget types defined in the database rather than the compiled registry,
    // so an admin can rename them, resize defaults, restrict platforms or
    // disable them without a rebuild. Data comes from the poller's snapshot
    // sections; the view from components/widgets/custom-registry.
    `CREATE TABLE IF NOT EXISTS custom_widgets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'puzzle',
        category TEXT NOT NULL DEFAULT 'custom',
        default_size TEXT NOT NULL DEFAULT '{"w":8,"h":6}',
        min_size TEXT NOT NULL DEFAULT '{"w":4,"h":4}',
        refresh_interval INTEGER NOT NULL DEFAULT 30,
        supports_linux INTEGER NOT NULL DEFAULT 1,
        supports_windows INTEGER NOT NULL DEFAULT 1,
        config_schema TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Ollama Status is the first widget moved out of the compiled registry.
    `INSERT OR IGNORE INTO custom_widgets
        (id, type, display_name, description, icon, category, default_size, min_size, refresh_interval, supports_linux, supports_windows, config_schema, enabled, builtin)
     VALUES ('custom-ollama-status', 'ollama_status', 'Ollama Status',
        'Models, loaded models and their CPU/GPU memory split; pull and delete (admin)',
        'bot', 'ai', '{"w":8,"h":8}', '{"w":6,"h":5}', 30, 1, 1, '[]', 1, 1)`,
];

// ---- Version 3: second WoL MAC and per-node WoL sender ----
const V3_WOL_HOSTS: string[] = [
    // Machines that move between wired and wireless have two NICs to wake.
    // NULL = not known yet (the poller fills both from the host's NICs);
    // '' = deliberately empty.
    `ALTER TABLE servers ADD COLUMN mac_address_alt TEXT`,
    // How magic packets are sent: 'auto' = over SSH from the managed server
    // this Bosun node's container runs on (mapped or detected), falling back to
    // the container; 'local_server' = always from wol.local_server_id;
    // 'container' = from the Bosun container itself.
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('wol.sender', 'auto', 'How Wake-on-LAN packets are sent: auto, local_server or container')`,
    `UPDATE app_config SET value = 'local_server' WHERE key = 'wol.sender' AND EXISTS (SELECT 1 FROM app_config WHERE key = 'wol.use_local_server' AND value = 'true')`,
];

// ---- Version 4: accounts, API keys, password reset, MFA ----
// Access levels (stored role values): viewer = read only (statistics and live
// data); operator = read + actions (widget actions such as container
// start/stop, model pull/delete, updates, wake; no shells or arbitrary
// commands); admin = full access.
const V4_ACCESS: string[] = [
    `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
    // 'none' | 'totp' | 'email'. totp_secret holds the encrypted TOTP seed.
    `ALTER TABLE users ADD COLUMN mfa_method TEXT NOT NULL DEFAULT 'none'`,
    // JSON array of SHA-256 hashes of unused one-time backup codes.
    `ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT`,
    `ALTER TABLE users ADD COLUMN password_changed_at DATETIME`,

    // API-only access keys. The secret is shown once; only its hash is kept.
    `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        last_used_ip TEXT,
        expires_at DATETIME,
        revoked_at DATETIME
    )`,

    `CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`,

    // Short-lived second-factor challenges (login step 2; email codes).
    `CREATE TABLE IF NOT EXISTS mfa_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        code_hash TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // SMTP (smtp.*) and the public URL used in emailed links.
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('app.url', '', 'Public URL of Bosun, used in emailed links (e.g. password reset)')`,
    `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('smtp.enabled', 'false', 'Whether outgoing email is configured')`,
];

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: 'baseline',
        statements: [
            ...BASELINE,
            ...DEFAULT_CONFIG.map(([k, v, d]) =>
                `INSERT OR IGNORE INTO app_config (key, value, description) VALUES ('${k}', '${v.replace(/'/g, "''")}', '${d.replace(/'/g, "''")}')`),
        ],
    },
    { version: 2, name: 'wol_and_custom_widgets', statements: V2_WOL_AND_CUSTOM_WIDGETS },
    { version: 3, name: 'wol_hosts', statements: V3_WOL_HOSTS },
    { version: 4, name: 'access', statements: V4_ACCESS },
];

/** The schema version this build expects. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Expected versions as strings (kept for backup metadata). */
export const EXPECTED_MIGRATIONS: string[] = MIGRATIONS.map(m => String(m.version));

/** Tables the application expects to exist once the schema is current. */
export const CORE_TABLES: string[] = [
    'schema_migrations',
    'app_config',
    'users',
    'sessions',
    'ssh_keys',
    'servers',
    'dashboards',
    'widgets',
    'host_snapshots',
    'metric_samples',
    'metric_rollups',
    'audit_log',
    'alert_rules',
    'notifications',
    'notification_channels',
    'custom_widgets',
    'api_keys',
    'password_resets',
    'mfa_challenges',
];

export class LegacySchemaError extends Error {
    constructor() {
        super('Database was created by an older Bosun schema (pre-2.0) and cannot be upgraded in place. ' +
            'Start with an empty data volume, or set BOSUN_DB_RESET=1 once to drop all tables and re-create the schema.');
        this.name = 'LegacySchemaError';
    }
}

async function listTables(): Promise<string[]> {
    const r = await rqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    return r.values.map(row => String(row[0]));
}

/** Drop every table (used only for an explicit BOSUN_DB_RESET=1). */
async function dropAllTables(tables: string[]): Promise<void> {
    if (!tables.length) return;
    await rqlite.executeBatch(
        [{ sql: 'PRAGMA foreign_keys = OFF' }, ...tables.map(t => ({ sql: `DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"` }))],
        { transaction: true },
    );
}

/** Highest applied schema version (0 when the schema is empty). */
export async function getCurrentVersion(): Promise<number> {
    const tables = await listTables();
    if (!tables.includes('schema_migrations')) return 0;
    const r = await rqlite.query('SELECT MAX(version) FROM schema_migrations');
    return Number(r.values[0]?.[0] ?? 0) || 0;
}

export async function runMigrations(): Promise<void> {
    let tables = await listTables();
    const legacy = tables.includes('migrations') && !tables.includes('schema_migrations');
    // Only a legacy schema is ever reset, so leaving BOSUN_DB_RESET=1 set
    // cannot wipe a current database on a later restart.
    if (legacy) {
        if (process.env.BOSUN_DB_RESET !== '1') throw new LegacySchemaError();
        console.warn(`[db] BOSUN_DB_RESET=1: dropping ${tables.length} legacy table(s) and re-creating the schema`);
        await dropAllTables(tables);
        tables = [];
    }

    await rqlite.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const current = await getCurrentVersion();
    if (current > SCHEMA_VERSION) {
        throw new Error(`Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}). Refusing to start; restore a matching image or backup.`);
    }

    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        console.log(`[db] applying schema migration ${m.version} (${m.name}, ${m.statements.length} statements)`);
        try {
            await rqlite.executeBatch(
                [
                    ...m.statements.map(sql => ({ sql })),
                    { sql: 'INSERT INTO schema_migrations (version, name) VALUES (?, ?)', params: [m.version, m.name] },
                ],
                { transaction: true },
            );
        } catch (err) {
            // In a cluster every node starts the same migrations; the loser of
            // the race gets an error (duplicate column / version) after the
            // winner's transaction committed. That is success, not failure.
            if ((await getCurrentVersion().catch(() => 0)) >= m.version) {
                console.log(`[db] migration ${m.version} was applied by another node`);
                continue;
            }
            throw err;
        }
    }
    console.log(`[db] schema at version ${SCHEMA_VERSION}`);
}

export interface MigrationStatus {
    expected: string[];
    applied: string[];
    /** Expected versions that have not been applied yet. */
    missing: string[];
    /** Applied versions this build does not know about (e.g. after a downgrade). */
    pending: string[];
    schemaVersion: string;
    legacy: boolean;
    upToDate: boolean;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
    const tables = await listTables();
    const legacy = tables.includes('migrations') && !tables.includes('schema_migrations');
    let applied: string[] = [];
    if (tables.includes('schema_migrations')) {
        const r = await rqlite.query('SELECT version FROM schema_migrations ORDER BY version');
        applied = r.values.map(row => String(row[0]));
    }
    const appliedSet = new Set(applied);
    const expectedSet = new Set(EXPECTED_MIGRATIONS);
    const missing = EXPECTED_MIGRATIONS.filter(v => !appliedSet.has(v));
    return {
        expected: EXPECTED_MIGRATIONS,
        applied,
        missing,
        pending: applied.filter(v => !expectedSet.has(v)),
        schemaVersion: applied.length ? applied[applied.length - 1] : '0',
        legacy,
        upToDate: !legacy && missing.length === 0,
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
        "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        [key, value]
    );
}
