/**
 * Database health report.
 *
 * Aggregates readiness, raft status, migration state, expected tables, row
 * counts and seeded config keys into a single `ok | degraded | error` verdict:
 *
 *  - `error`    the node is not ready (unreachable, no leader, or not writable).
 *  - `degraded` reachable but incomplete: a check failed, a core table or seeded
 *               config key is missing, or expected migrations have not been applied.
 *  - `ok`       ready with every expected migration and table present.
 *
 * Never throws: a failing probe is recorded in `errors` so the page can still
 * render whatever else succeeded.
 */
import { rqlite } from '../db/rqlite-client';
import {
  getMigrationStatus,
  CORE_TABLES,
  SCHEMA_VERSION,
  MigrationStatus,
} from '../db/migrations';

// app_config keys seeded by migration 002. A healthy database has all of them.
const SEEDED_CONFIG_KEYS = [
  'app.setup_complete',
  'app.theme',
  'app.timezone',
  'app.date_format',
  'app.refresh_interval',
  'ssh.timeout',
  'ssh.keepalive_interval',
  'alerts.enabled',
  'alerts.check_interval',
  'cleanup.audit_log_days',
  'cleanup.notification_days',
  'cleanup.session_days',
];

export interface DatabaseHealth {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  schemaVersion: string;
  nodeId: string | null;
  leader: string | null;
  raftIndex: number | null;
  migrations: MigrationStatus | null;
  tables: { expected: string[]; present: string[]; missing: string[] };
  counts: Record<string, number>;
  missingConfigKeys: string[];
  errors: string[];
}

interface RaftSummary {
  nodeId: string | null;
  leader: string | null;
  raftIndex: number | null;
}

function readRaftSummary(status: unknown): RaftSummary {
  const store = (status as any)?.store;
  const raft = store?.raft;
  const servers = raft?.servers || {};

  const nodeId = raft?.node_id ?? store?.node_id ?? null;
  const leaderEntry = Object.values(servers).find((n: any) => n?.leader) as any;
  const leader = raft?.leader_addr ?? leaderEntry?.addr ?? null;
  const raftIndex = typeof raft?.last_index === 'number' ? raft.last_index : null;

  return { nodeId, leader, raftIndex };
}

async function getPresentTables(): Promise<string[]> {
  const result = await rqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'");
  return result.values.map(row => String(row[0]));
}

async function getRowCounts(tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      const result = await rqlite.query(`SELECT COUNT(*) FROM ${table}`);
      counts[table] = Number(result.values[0]?.[0] ?? 0);
    } catch {
      counts[table] = -1;
    }
  }
  return counts;
}

async function getConfigKeys(): Promise<string[]> {
  const result = await rqlite.query('SELECT key FROM app_config');
  return result.values.map(row => String(row[0]));
}

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const errors: string[] = [];
  const health: DatabaseHealth = {
    status: 'error',
    ready: false,
    schemaVersion: SCHEMA_VERSION,
    nodeId: null,
    leader: null,
    raftIndex: null,
    migrations: null,
    tables: { expected: CORE_TABLES, present: [], missing: CORE_TABLES },
    counts: {},
    missingConfigKeys: [],
    errors,
  };

  try {
    health.ready = await rqlite.isReady();
  } catch (err) {
    errors.push(`readiness check failed: ${String(err)}`);
  }

  try {
    const raft = readRaftSummary(await rqlite.getStatus());
    health.nodeId = raft.nodeId;
    health.leader = raft.leader;
    health.raftIndex = raft.raftIndex;
  } catch (err) {
    errors.push(`status check failed: ${String(err)}`);
  }

  try {
    health.migrations = await getMigrationStatus();
  } catch (err) {
    errors.push(`migration check failed: ${String(err)}`);
  }

  try {
    const present = await getPresentTables();
    health.tables.present = present;
    health.tables.missing = CORE_TABLES.filter(t => !present.includes(t));
    health.counts = await getRowCounts(CORE_TABLES.filter(t => present.includes(t)));
  } catch (err) {
    errors.push(`table check failed: ${String(err)}`);
  }

  try {
    const keys = await getConfigKeys();
    health.missingConfigKeys = SEEDED_CONFIG_KEYS.filter(k => !keys.includes(k));
  } catch (err) {
    errors.push(`config check failed: ${String(err)}`);
  }

  if (!health.ready) {
    health.status = 'error';
  } else if (
    errors.length > 0 ||
    health.tables.missing.length > 0 ||
    health.missingConfigKeys.length > 0 ||
    (health.migrations && !health.migrations.upToDate)
  ) {
    health.status = 'degraded';
  } else {
    health.status = 'ok';
  }

  return health;
}
