/**
 * Database backup, restore and portable export/import.
 *
 * Three formats are supported, each with different trade-offs:
 *
 *  - `json`   Portable, inspectable document. Supports table scope and secret
 *             redaction. Import merges row-by-row with INSERT OR REPLACE.
 *  - `sqlite` Raw SQLite file from rqlite's hot-backup endpoint (`/db/backup`).
 *             Full fidelity, but secrets cannot be redacted and restore replaces
 *             the whole database via `/db/load`.
 *  - `sql`    Text dump of DDL + INSERTs, restored the same way as `sqlite`.
 *
 * Secrets (encrypted SSH keys, password hashes, TOTP seeds) are redacted by
 * default in JSON exports. Opting in emits the *encrypted* ciphertext only -
 * plaintext is never exported. Redacted rows are skipped on import so a
 * placeholder can never overwrite a real credential.
 */
import { rqlite, rowsToObjects } from './rqlite-client';
import { runMigrations } from './migrations';
import { invalidateUserStatus } from '@/lib/auth/user-status';
import { invalidateApiKeyCache } from '@/lib/auth/api-key-auth';
import { invalidatePermissionCache } from '@/lib/permissions/store';
import {
  EXPECTED_MIGRATIONS,
  SCHEMA_VERSION,
  getMigrationStatus,
} from './migrations';

export const BACKUP_FORMAT_VERSION = 1;

export type BackupFormat = 'json' | 'sqlite' | 'sql';

// Tables included in a JSON backup, ordered so that foreign keys are satisfied
// on import (referenced tables first).
export const BACKUP_TABLES: string[] = [
  'ssh_keys',
  'servers',
  'dashboards',
  'widgets',
  'alert_rules',
  'notifications',
  'notification_channels',
  'app_config',
  'users',
  'sessions',
  'audit_log',
  'host_snapshots',
  'metric_rollups',
  'metric_samples',
  'custom_widgets',
  'api_keys',
  // Permission groups: groups and server groups before the rows that reference them.
  'permission_groups',
  'permission_grants',
  'server_groups',
  'server_group_members',
  'user_groups',
  'api_key_groups',
  'permission_definitions',
  'widget_packages',
  'metric_definitions',
  'access_requests',
];

// Tables excluded by default because they can grow very large.
export const LARGE_TABLES: string[] = ['metric_samples', 'metric_rollups', 'host_snapshots', 'audit_log'];

// Columns that hold encrypted credentials. Redacted by default in JSON exports.
const SECRET_COLUMNS = ['private_key_enc', 'passphrase_enc', 'password_hash', 'totp_secret', 'mfa_backup_codes', 'key_hash'];
const REDACTED_PLACEHOLDER = '__REDACTED__';

export interface BackupMeta {
  format: BackupFormat;
  formatVersion: number;
  schemaVersion: string;
  appVersion: string;
  exportedAt: string;
  nodeId: string | null;
  migrationIds: string[];
  includesSecrets: boolean;
  tables: string[];
}

export interface BackupDocument {
  meta: BackupMeta;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface ExportOptions {
  format?: BackupFormat;
  tables?: string[];
  includeSecrets?: boolean;
  excludeLarge?: boolean;
}

export interface ExportResult {
  format: BackupFormat;
  contentType: string;
  filename: string;
  // JSON: serializable document. sqlite/sql: raw bytes / text to stream directly.
  body: BackupDocument | Uint8Array | string;
}

export interface ImportOptions {
  // Full restore (rqlite /db/load). Required for sqlite/sql, optional for json.
  replace?: boolean;
}

export interface ImportResult {
  format: BackupFormat;
  schemaVersion: string | null;
  counts: Record<string, number>;
  warnings: string[];
}

function redactRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const copy: Record<string, unknown> = { ...row };
    for (const col of SECRET_COLUMNS) {
      if (copy[col] !== null && copy[col] !== undefined) {
        copy[col] = REDACTED_PLACEHOLDER;
      }
    }
    return copy;
  });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildMeta(
  format: BackupFormat,
  migrationIds: string[],
  tables: string[],
  includesSecrets: boolean,
): BackupMeta {
  const schemaVersion = migrationIds.length
    ? migrationIds[migrationIds.length - 1]
    : String(SCHEMA_VERSION);
  return {
    format,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    appVersion: process.env.npm_package_version || '0.1.0',
    exportedAt: new Date().toISOString(),
    nodeId: process.env.NODE_NAME || null,
    migrationIds,
    includesSecrets,
    tables,
  };
}

async function collectJsonTables(
  tables: string[],
  includeSecrets: boolean,
): Promise<Record<string, Record<string, unknown>[]>> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const result = await rqlite.query(`SELECT * FROM ${table}`);
    const rows = rowsToObjects(result);
    out[table] = includeSecrets ? rows : redactRows(rows);
  }
  return out;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function buildSqlDump(): Promise<string> {
  const lines: string[] = [
    `-- Bosun SQL dump`,
    `-- schema version: ${SCHEMA_VERSION}`,
    `-- format version: ${BACKUP_FORMAT_VERSION}`,
    `-- exported at: ${new Date().toISOString()}`,
    '',
  ];

  // schema_migrations comes along so a restore knows which migrations the data already has (without it every migration
  // would run again on the restored tables); indexes are dumped too, since DROP TABLE takes them with it.
  const dumpTables = BACKUP_TABLES.includes('schema_migrations') ? BACKUP_TABLES : [...BACKUP_TABLES, 'schema_migrations'];
  for (const table of dumpTables) {
    const schemaResult = await rqlite.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    );
    const ddl = schemaResult.values[0]?.[0];
    if (!ddl) continue;

    lines.push(`DROP TABLE IF EXISTS ${table};`);
    lines.push(`${String(ddl)};`);

    const rowsResult = await rqlite.query(`SELECT * FROM ${table}`);
    const rows = rowsToObjects(rowsResult);
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => sqlLiteral(row[c]));
      lines.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
    }
    lines.push('');
  }

  const indexes = await rqlite.query("SELECT sql, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name");
  for (const [ddl, tbl] of indexes.values || []) {
    if (ddl && dumpTables.includes(String(tbl))) lines.push(`${String(ddl).replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, (_m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `)};`);
  }

  return lines.join('\n');
}

/**
 * Build a backup in the requested format. Defaults to a redacted JSON export.
 * The requested table list is intersected with `BACKUP_TABLES` so callers can
 * never widen the scope to arbitrary tables.
 */
export async function exportDatabase(options: ExportOptions = {}): Promise<ExportResult> {
  const format: BackupFormat = options.format ?? 'json';
  const migrationIds = (await getMigrationStatus()).applied;
  const stamp = timestamp();

  if (format === 'sqlite') {
    const bytes = new Uint8Array(await rqlite.backup());
    return {
      format,
      contentType: 'application/octet-stream',
      filename: `bosun-backup-${stamp}.sqlite`,
      body: bytes,
    };
  }

  if (format === 'sql') {
    const dump = await buildSqlDump();
    return {
      format,
      contentType: 'text/plain; charset=utf-8',
      filename: `bosun-backup-${stamp}.sql`,
      body: dump,
    };
  }

  const includeSecrets = options.includeSecrets ?? false;
  let tables = options.tables && options.tables.length ? options.tables : [...BACKUP_TABLES];
  tables = tables.filter(t => BACKUP_TABLES.includes(t));
  if (options.excludeLarge) {
    tables = tables.filter(t => !LARGE_TABLES.includes(t));
  }

  const document: BackupDocument = {
    meta: buildMeta('json', migrationIds, tables, includeSecrets),
    tables: await collectJsonTables(tables, includeSecrets),
  };

  return {
    format,
    contentType: 'application/json',
    filename: `bosun-backup-${stamp}.json`,
    body: document,
  };
}

/** Sniff the format of an uploaded backup from its leading bytes. */
export function detectFormat(data: Uint8Array): BackupFormat {
  // SQLite files begin with the 16-byte magic string "SQLite format 3\0".
  const magic = Buffer.from(data.subarray(0, 16)).toString('binary');
  if (magic.startsWith('SQLite format 3')) return 'sqlite';

  const head = Buffer.from(data.subarray(0, 512)).toString('utf8').trimStart();
  if (head.startsWith('{')) return 'json';
  return 'sql';
}

/**
 * Restore a backup previously produced by {@link exportDatabase}.
 *
 * `sqlite`/`sql` are handed to rqlite's `/db/load`, which replaces the entire
 * database - the caller is responsible for confirming that with the user.
 * `json` is merged row-by-row and only touches tables present in the document.
 */
export async function importDatabase(
  data: Uint8Array,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const format = detectFormat(data);
  const warnings: string[] = [];

  // sqlite/sql replace the whole database, so they need the explicit replace flag (the route's contract). The loaded
  // database is then brought up to this build's schema (an older backup lacks newer tables and indexes).
  if (format === 'sqlite' || format === 'sql') {
    if (!options.replace) throw new Error(`A ${format} backup replaces the whole database: confirm with replace=true`);
    if (format === 'sqlite') await rqlite.load(data, 'application/octet-stream');
    else await rqlite.load(Buffer.from(data).toString('utf8'), 'text/plain');
    await runMigrations();
    invalidateCaches();
    return { format, schemaVersion: null, counts: {}, warnings };
  }

  const doc = JSON.parse(Buffer.from(data).toString('utf8')) as BackupDocument;
  if (!doc?.meta || !doc?.tables) {
    throw new Error('Invalid backup file: missing meta or tables');
  }
  if (doc.meta.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Backup format version ${doc.meta.formatVersion} is newer than supported (${BACKUP_FORMAT_VERSION})`,
    );
  }
  if (!EXPECTED_MIGRATIONS.includes(doc.meta.schemaVersion)) {
    throw new Error(`Backup schema version ${doc.meta.schemaVersion} is not recognised by this build`);
  }

  const counts: Record<string, number> = {};
  const replace = options.replace ?? false;
  for (const table of BACKUP_TABLES) {
    const rows = doc.tables[table];
    if (!rows || rows.length === 0) continue;

    // Skip rows whose redacted secrets would overwrite real credentials with a placeholder.
    const usableRows = rows.filter(row =>
      !SECRET_COLUMNS.some(col => row[col] === REDACTED_PLACEHOLDER),
    );
    if (usableRows.length < rows.length) {
      warnings.push(`${table}: skipped ${rows.length - usableRows.length} row(s) with redacted secrets`);
    }
    if (usableRows.length === 0) continue;

    // Column names come from the uploaded file: only this table's real columns are used (never put into SQL unchecked).
    const info = rowsToObjects(await rqlite.query(`PRAGMA table_info(${table})`));
    const known = new Set(info.map(c => String(c.name)));
    const pk = info.filter(c => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(c => String(c.name));
    const seen = Array.from(new Set(usableRows.flatMap(row => Object.keys(row))));
    const columns = seen.filter(c => known.has(c));
    const dropped = seen.filter(c => !known.has(c));
    if (dropped.length) warnings.push(`${table}: ignored unknown column(s) ${dropped.slice(0, 5).join(', ')}`);
    if (!columns.length || (pk.length && !pk.every(c => columns.includes(c)))) {
      warnings.push(`${table}: skipped (no usable columns)`);
      continue;
    }
    // Upsert by primary key. Unlike INSERT OR REPLACE, a clash on another unique column (a user name, a server name)
    // fails the table instead of silently deleting the existing row with a different id.
    const placeholders = columns.map(() => '?').join(', ');
    const updates = columns.filter(c => !pk.includes(c)).map(c => `${c} = excluded.${c}`).join(', ');
    const upsert = pk.length
      ? `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${pk.join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`
      : `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
    const statements = [
      ...(replace ? [{ sql: `DELETE FROM ${table}`, params: [] as unknown[] }] : []),
      ...usableRows.map(row => ({ sql: upsert, params: columns.map(c => row[c] ?? null) })),
    ];
    // One transaction per table: it is restored completely or not at all.
    try {
      await rqlite.executeBatch(statements, { transaction: true });
    } catch (err) {
      invalidateCaches();
      throw new Error(`Restoring ${table} failed, so that table was left unchanged${Object.keys(counts).length ? ` (already restored: ${Object.keys(counts).join(', ')})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    }
    counts[table] = usableRows.length;
  }

  invalidateCaches();  return { format, schemaVersion: doc.meta.schemaVersion, counts, warnings };
}

/** Users, API keys and permissions were possibly rewritten: drop the cached copies in this process.
 * (Other nodes pick the changes up when their short-lived caches expire.) */
function invalidateCaches(): void {
  invalidateUserStatus();
  invalidateApiKeyCache();
  invalidatePermissionCache();
}
