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
  'widget_polling_config',
  'widget_data_cache',
];

// Tables excluded by default because they can grow very large.
export const LARGE_TABLES: string[] = ['widget_data_cache', 'audit_log'];

// Columns that hold encrypted credentials. Redacted by default in JSON exports.
const SECRET_COLUMNS = ['private_key_enc', 'passphrase_enc', 'password_hash', 'totp_secret'];
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
    : SCHEMA_VERSION;
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

  for (const table of BACKUP_TABLES) {
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

  if (format === 'sqlite') {
    await rqlite.load(data, 'application/octet-stream');
    return { format, schemaVersion: null, counts: {}, warnings };
  }

  if (format === 'sql') {
    await rqlite.load(Buffer.from(data).toString('utf8'), 'text/plain');
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

    if (replace) {
      await rqlite.execute(`DELETE FROM ${table}`);
    }

    const columns = Object.keys(usableRows[0]);
    const statements = usableRows.map(row => {
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(c => row[c] ?? null);
      return { sql: `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params: values };
    });

    await rqlite.executeBatch(statements);
    counts[table] = usableRows.length;
  }

  return { format, schemaVersion: doc.meta.schemaVersion, counts, warnings };
}
