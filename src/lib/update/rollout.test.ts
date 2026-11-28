import { describe, it, expect, vi, beforeEach } from 'vitest';

const retry = vi.hoisted(() => vi.fn(async () => undefined));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@/lib/widgets/bundled-seed', () => ({ retryDeferredBundledPackages: retry }));
vi.mock('@/lib/db/migrations', () => ({
  getConfig: async (key: string) => store.get(key) ?? null,
  setConfig: async (key: string, value: string) => { store.set(key, value); },
}));
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: {
    getNodes: async () => [], getStatus: async () => null,
    query: async () => ({ columns: [], values: [] }), execute: async () => ({}),
  },
  rowsToObjects: () => [],
}));
vi.mock('@/lib/notifications/store', () => ({ notify: async () => true, resolveByKeyPrefix: async () => 0 }));
vi.mock('@/lib/audit/logger', () => ({
  logAudit: async () => undefined,
  AuditActions: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));
vi.mock('@/lib/network/node-host', () => ({
  nodeName: () => 'node-a', detectNodeHost: async () => null, ownContainerIds: () => [],
}));
vi.mock('@/lib/portainer/import', () => ({ stackManager: async () => null }));
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadDataset: async () => null, loadRuntimeData: async () => null }));
vi.mock('@/lib/widgets/runtime/run-action', () => ({ runWidgetAction: async () => null }));
vi.mock('./registry', () => ({ imageRevision: async () => ({ commit: null, digest: null }) }));

import { finishRolloutOnStart } from './rollout';

const runningRollout = (stepStatus: 'restarting' | 'done' = 'restarting') => ({
  id: '1', kind: 'update', target: 'abcdef1', from: null, image: 'ghcr.io/x/bosun:sha-abcdef1',
  started_by: 'alice', started_at: new Date().toISOString(), finished_at: null, status: 'running', backup: null,
  steps: [{ node: 'node-a', self: true, server_id: null, project: null, service: null, as: null, status: stepStatus, message: null, from: null }],
});

beforeEach(() => {
  retry.mockClear();
  store.clear();
  process.env.BOSUN_COMMIT = 'abcdef1234567890';
});

describe('a finished rollout retries the deferred bundled packages', () => {
  it('closes the record and retries when the last node comes back on the target', async () => {
    store.set('update.rollout', JSON.stringify(runningRollout()));
    await finishRolloutOnStart();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get('update.rollout')!)).toMatchObject({ status: 'done' });
  });

  it('does nothing while a rollout is still moving other nodes', async () => {
    store.set('update.rollout', JSON.stringify(runningRollout('done')));
    await finishRolloutOnStart();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does nothing when there is no rollout', async () => {
    await finishRolloutOnStart();
    expect(retry).not.toHaveBeenCalled();
  });
});
