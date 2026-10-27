import { describe, it, expect } from 'vitest';
import { overallStatus, readRaftSummary, HealthCheck } from './db-health';

const check = (name: string, status: HealthCheck['status']): HealthCheck => ({ name, status, detail: '', durationMs: 0 });

describe('overallStatus', () => {
  it('is ok when every check passes', () => {
    expect(overallStatus([check('readiness', 'ok'), check('write', 'ok'), check('schema', 'ok')])).toBe('ok');
  });
  it('is error when the node is not ready or not writable', () => {
    expect(overallStatus([check('readiness', 'fail')])).toBe('error');
    expect(overallStatus([check('readiness', 'ok'), check('write', 'fail')])).toBe('error');
  });
  it('is degraded for other failures and warnings', () => {
    expect(overallStatus([check('readiness', 'ok'), check('schema', 'fail')])).toBe('degraded');
    expect(overallStatus([check('readiness', 'ok'), check('metrics', 'warn')])).toBe('degraded');
  });
});

describe('readRaftSummary', () => {
  it('reads rqlite 8 status output', () => {
    const s = readRaftSummary({
      store: {
        node_id: 'node1',
        leader: { addr: 'localhost:4002', node_id: 'node1' },
        raft: { last_index: 42, state: 'Leader' },
        sqlite3: { db_size: 8192 },
      },
    });
    expect(s).toEqual({ nodeId: 'node1', leader: 'localhost:4002', raftIndex: 42, dbSizeBytes: 8192 });
  });
  it('tolerates missing fields', () => {
    expect(readRaftSummary({})).toEqual({ nodeId: null, leader: null, raftIndex: null, dbSizeBytes: null });
  });
});
