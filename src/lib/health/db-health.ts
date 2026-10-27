/**
 * Database health report.
 *
 * Runs a set of named checks and folds them into one `ok | degraded | error`
 * verdict:
 *
 *  - readiness   rqlite /readyz answers (node up, leader known)
 *  - write       a round-trip write to app_config succeeds (raft commit works)
 *  - schema      schema_migrations is at the version this build expects
 *  - tables      every core table exists
 *  - config      every seeded app_config key exists
 *  - integrity   SQLite `PRAGMA quick_check` reports ok
 *  - metrics     the poller wrote metric samples recently (only when servers exist)
 *
 * `error` means not ready or not writable; `degraded` means reachable but some
 * other check failed. Never throws: a failing probe is recorded as a failed
 * check (and in `errors`) so the page can still render the rest.
 */
import { rqlite } from '../db/rqlite-client';
import {
  getMigrationStatus,
  CORE_TABLES,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  MigrationStatus,
} from '../db/migrations';

const SEEDED_CONFIG_KEYS = DEFAULT_CONFIG.map(([key]) => key);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
}

export interface DatabaseHealth {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  writable: boolean;
  schemaVersion: string;
  nodeId: string | null;
  leader: string | null;
  raftIndex: number | null;
  dbSizeBytes: number | null;
  migrations: MigrationStatus | null;
  tables: { expected: string[]; present: string[]; missing: string[] };
  counts: Record<string, number>;
  missingConfigKeys: string[];
  /** Newest metric sample per server (epoch seconds), keyed by server id. */
  latestSamples: Record<string, number>;
  checks: HealthCheck[];
  errors: string[];
  checkedAt: string;
}

interface RaftSummary {
  nodeId: string | null;
  leader: string | null;
  raftIndex: number | null;
  dbSizeBytes: number | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function readRaftSummary(status: unknown): RaftSummary {
  const store = (status as any)?.store;
  const raft = store?.raft;
  const nodes = Array.isArray(store?.nodes) ? store.nodes : Object.values(raft?.servers || {});
  const leaderEntry = nodes.find((n: any) => n?.leader) as any;
  const size = store?.sqlite3?.db_size ?? store?.sqlite3?.size ?? null;
  return {
    nodeId: store?.node_id ?? raft?.node_id ?? null,
    leader: store?.leader?.addr ?? raft?.leader_addr ?? leaderEntry?.addr ?? null,
    raftIndex: typeof raft?.last_index === 'number' ? raft.last_index
      : typeof raft?.applied_index === 'number' ? raft.applied_index : null,
    dbSizeBytes: typeof size === 'number' ? size : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Fold check results into the overall verdict. */
export function overallStatus(checks: HealthCheck[]): DatabaseHealth['status'] {
  const failed = new Set(checks.filter(c => c.status === 'fail').map(c => c.name));
  if (failed.has('readiness') || failed.has('write')) return 'error';
  if (failed.size > 0 || checks.some(c => c.status === 'warn')) return 'degraded';
  return 'ok';
}

async function timed(
  checks: HealthCheck[],
  errors: string[],
  name: string,
  fn: () => Promise<{ status: CheckStatus; detail: string }>,
): Promise<void> {
  const start = Date.now();
  try {
    const r = await fn();
    checks.push({ name, ...r, durationMs: Date.now() - start });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    errors.push(`${name}: ${detail}`);
    checks.push({ name, status: 'fail', detail, durationMs: Date.now() - start });
  }
}

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const checks: HealthCheck[] = [];
  const errors: string[] = [];
  const health: DatabaseHealth = {
    status: 'error',
    ready: false,
    writable: false,
    schemaVersion: String(SCHEMA_VERSION),
    nodeId: null,
    leader: null,
    raftIndex: null,
    dbSizeBytes: null,
    migrations: null,
    tables: { expected: CORE_TABLES, present: [], missing: CORE_TABLES },
    counts: {},
    missingConfigKeys: [],
    latestSamples: {},
    checks,
    errors,
    checkedAt: new Date().toISOString(),
  };

  await timed(checks, errors, 'readiness', async () => {
    health.ready = await rqlite.isReady();
    try {
      Object.assign(health, readRaftSummary(await rqlite.getStatus()));
    } catch (err) {
      errors.push(`status: ${String(err)}`);
    }
    return health.ready
      ? { status: 'ok', detail: health.leader ? `leader ${health.leader}` : 'ready' }
      : { status: 'fail', detail: 'rqlite /readyz did not answer OK' };
  });

  if (!health.ready) {
    health.status = overallStatus(checks);
    return health;
  }

  await timed(checks, errors, 'schema', async () => {
    health.migrations = await getMigrationStatus();
    const m = health.migrations;
    if (m.legacy) return { status: 'fail', detail: 'legacy pre-2.0 schema; start fresh or set BOSUN_DB_RESET=1' };
    if (!m.upToDate) return { status: 'fail', detail: `at ${m.schemaVersion}, expected ${SCHEMA_VERSION} (missing ${m.missing.join(', ')})` };
    if (m.pending.length) return { status: 'warn', detail: `unknown versions applied: ${m.pending.join(', ')}` };
    return { status: 'ok', detail: `version ${m.schemaVersion}` };
  });

  await timed(checks, errors, 'write', async () => {
    const stamp = new Date().toISOString();
    await rqlite.execute(
      "INSERT INTO app_config (key, value, description) VALUES ('db.health_probe', ?, 'Last database write probe') " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
      [stamp],
    );
    const r = await rqlite.query("SELECT value FROM app_config WHERE key = 'db.health_probe'");
    health.writable = r.values[0]?.[0] === stamp;
    return health.writable
      ? { status: 'ok', detail: 'write + read-back succeeded' }
      : { status: 'fail', detail: 'read-back did not match the written value' };
  });

  await timed(checks, errors, 'tables', async () => {
    const r = await rqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'");
    const present = r.values.map(row => String(row[0]));
    health.tables.present = present;
    health.tables.missing = CORE_TABLES.filter(t => !present.includes(t));
    for (const table of CORE_TABLES.filter(t => present.includes(t))) {
      try {
        const c = await rqlite.query(`SELECT COUNT(*) FROM ${table}`);
        health.counts[table] = Number(c.values[0]?.[0] ?? 0);
      } catch {
        health.counts[table] = -1;
      }
    }
    return health.tables.missing.length
      ? { status: 'fail', detail: `missing: ${health.tables.missing.join(', ')}` }
      : { status: 'ok', detail: `${CORE_TABLES.length} core tables present` };
  });

  await timed(checks, errors, 'config', async () => {
    const r = await rqlite.query('SELECT key FROM app_config');
    const keys = r.values.map(row => String(row[0]));
    health.missingConfigKeys = SEEDED_CONFIG_KEYS.filter(k => !keys.includes(k));
    return health.missingConfigKeys.length
      ? { status: 'warn', detail: `missing keys: ${health.missingConfigKeys.join(', ')}` }
      : { status: 'ok', detail: 'all seeded keys present' };
  });

  await timed(checks, errors, 'integrity', async () => {
    const r = await rqlite.query('PRAGMA quick_check');
    const result = String(r.values[0]?.[0] ?? '');
    return result === 'ok'
      ? { status: 'ok', detail: 'quick_check ok' }
      : { status: 'fail', detail: result || 'quick_check returned nothing' };
  });

  await timed(checks, errors, 'metrics', async () => {
    const servers = await rqlite.query('SELECT id, name, poll_enabled, poll_interval_sec FROM servers');
    if (servers.values.length === 0) return { status: 'ok', detail: 'no servers configured' };
    const latest = await rqlite.query('SELECT server_id, MAX(ts) FROM metric_samples GROUP BY server_id');
    for (const [id, ts] of latest.values) health.latestSamples[String(id)] = Number(ts);
    const now = Math.floor(Date.now() / 1000);
    const stale = servers.values
      .filter(([, , enabled]) => Number(enabled) === 1)
      .filter(([id, , , interval]) => {
        const last = health.latestSamples[String(id)];
        return !last || now - last > Math.max(120, Number(interval || 15) * 6);
      })
      .map(([, name]) => String(name));
    return stale.length
      ? { status: 'warn', detail: `no recent samples from: ${stale.join(', ')} (poller down or host unreachable)` }
      : { status: 'ok', detail: 'all polled servers reported recently' };
  });

  health.status = overallStatus(checks);
  return health;
}
