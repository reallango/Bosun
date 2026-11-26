import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TokenPayload } from '@/lib/auth/jwt';

const OLD = 'aaaaaaa111111111111111111111111111111111';
const NEW = 'bbbbbbb222222222222222222222222222222222';
const CID = 'abcdef123456';
const SPEC = {
  spec: {
    stacks: { retag: 'retag', list: 'list', fields: { id: 'id', project: 'project', service: 'service', image: 'image' } },
    actions: [{ id: 'retag' }],
  },
};

const m = vi.hoisted(() => ({
  config: {} as Record<string, string | null>,
  imageRevision: vi.fn(),
  backup: vi.fn(),
  getNodes: vi.fn(),
  logAudit: vi.fn(),
  notify: vi.fn(),
  stackManager: vi.fn(),
  loadRuntimeData: vi.fn(),
  loadDataset: vi.fn(),
  runWidgetAction: vi.fn(),
  listNodes: vi.fn(),
}));

vi.mock('@/lib/db/migrations', () => ({
  getConfig: async (key: string) => m.config[key] ?? null,
  setConfig: async (key: string, value: string) => { m.config[key] = value; },
}));
vi.mock('@/lib/db/rqlite-client', () => ({
  rqlite: { backup: m.backup, getNodes: m.getNodes, getStatus: async () => null },
  rowsToObjects: () => [],
}));
vi.mock('@/lib/audit/logger', () => ({ logAudit: m.logAudit }));
vi.mock('@/lib/notifications/store', () => ({ notify: m.notify }));
vi.mock('@/lib/network/node-host', () => ({ nodeName: () => 'n1', detectNodeHost: async () => null, ownContainerIds: () => [] }));
vi.mock('@/lib/portainer/import', () => ({ stackManager: m.stackManager }));
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadDataset: m.loadDataset, loadRuntimeData: m.loadRuntimeData }));
vi.mock('@/lib/widgets/runtime/run-action', () => ({ runWidgetAction: m.runWidgetAction }));
vi.mock('./registry', () => ({ imageRevision: m.imageRevision }));
vi.mock('./nodes', () => ({ listNodes: m.listNodes, health: async () => ({ healthy: false, commit: null, channel: null }) }));

import { startRollback } from './rollout';

const auth = { userId: 'u1', username: 'admin', role: 'admin' } as TokenPayload;
const at = '2026-05-01T10:00:00.000Z';

const finished = (over: Record<string, unknown> = {}) => JSON.stringify({
  target: NEW, from: OLD, status: 'done', started_at: at, finished_at: at, steps: [], ...over,
});

let dataDir = '';
beforeEach(() => {
  for (const key of Object.keys(m.config)) delete m.config[key];
  m.config['update.image'] = 'ghcr.io/reallango/bosun';
  m.config['update.channel'] = 'dev';
  m.imageRevision.mockReset();
  m.backup.mockReset();
  m.logAudit.mockReset().mockResolvedValue(undefined);
  m.notify.mockReset().mockResolvedValue(true);
  m.stackManager.mockReset().mockResolvedValue(null);
  m.loadRuntimeData.mockReset().mockResolvedValue(null);
  m.loadDataset.mockReset().mockResolvedValue(null);
  m.runWidgetAction.mockReset();
  m.listNodes.mockReset().mockResolvedValue([]);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-rollback-'));
  process.env.RQLITE_DATA_DIR = dataDir;
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); delete process.env.RQLITE_DATA_DIR; });

describe('starting a rollback', () => {
  it('refuses while an update is running, before asking the registry or backing up', async () => {
    m.config['update.rollout'] = finished({ status: 'running', finished_at: null, started_at: new Date().toISOString() });
    await expect(startRollback(auth)).rejects.toMatchObject({ code: 'UPDATE_RUNNING', status: 409 });
    expect(m.imageRevision).not.toHaveBeenCalled();
    expect(m.backup).not.toHaveBeenCalled();
  });

  it('refuses when the last rollout has no previous commit', async () => {
    await expect(startRollback(auth)).rejects.toMatchObject({ code: 'NO_PREVIOUS' });
    m.config['update.rollout'] = finished({ from: null });
    await expect(startRollback(auth)).rejects.toMatchObject({ code: 'NO_PREVIOUS' });
    expect(m.imageRevision).not.toHaveBeenCalled();
    expect(m.backup).not.toHaveBeenCalled();
  });

  it('refuses when the registry no longer has the previous commit\'s image', async () => {
    m.config['update.rollout'] = finished();
    m.imageRevision.mockResolvedValue({ commit: null, digest: null });
    await expect(startRollback(auth)).rejects.toMatchObject({ code: 'NO_IMAGE', status: 409 });
    expect(m.imageRevision).toHaveBeenCalledWith('ghcr.io/reallango/bosun', 'sha-aaaaaaa');
    expect(m.backup).not.toHaveBeenCalled();
  });

  it('refuses when the image tag was built from another commit', async () => {
    m.config['update.rollout'] = finished();
    m.imageRevision.mockResolvedValue({ commit: 'ccccccc333333333333333333333333333333333', digest: null });
    await expect(startRollback(auth)).rejects.toMatchObject({ code: 'NO_IMAGE' });
    expect(m.backup).not.toHaveBeenCalled();
  });

  it('starts a rollback to the previous commit, with a backup and kind "rollback"', async () => {
    m.config['update.rollout'] = finished();
    m.imageRevision.mockResolvedValue({ commit: OLD, digest: 'sha256:old' });
    m.backup.mockResolvedValue(Buffer.from('sqlite'));
    m.listNodes.mockResolvedValue([{
      id: 'n1', leader: true, reachable: true, web: 'http://n1:3042', healthy: true, commit: NEW, channel: 'dev', self: true,
      record: { server_id: 's1', container_id: CID, commit: NEW, at },
    }]);
    m.stackManager.mockResolvedValue(SPEC);
    m.loadRuntimeData.mockResolvedValue({ data: [{ id: CID, project: 'bosun', service: 'bosun', image: 'bosun:latest' }] });
    m.loadDataset.mockResolvedValue({ data: [{ name: 'bosun', source: 'compose' }] });
    m.runWidgetAction.mockResolvedValue(new Response(JSON.stringify({ data: { success: true } }), { status: 200 }));

    const rollout = await startRollback(auth);

    expect(rollout).toMatchObject({
      kind: 'rollback', target: OLD, from: NEW, image: 'ghcr.io/reallango/bosun:sha-aaaaaaa',
    });
    expect(rollout.steps[0]).toMatchObject({ node: 'n1', self: true, from: NEW });
    expect(m.imageRevision).toHaveBeenCalledWith('ghcr.io/reallango/bosun', 'sha-aaaaaaa');
    expect(m.backup).toHaveBeenCalled();
    expect(rollout.backup && fs.existsSync(rollout.backup)).toBe(true);
    expect(JSON.parse(m.config['update.rollout']!)).toMatchObject({ kind: 'rollback', target: OLD, from: NEW });
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'bosun.rollback_start' }));
    await vi.waitFor(() => expect(m.runWidgetAction).toHaveBeenCalledWith(
      auth, 's1', SPEC, expect.objectContaining({ id: 'retag' }),
      expect.objectContaining({ params: expect.objectContaining({ image: 'ghcr.io/reallango/bosun:sha-aaaaaaa' }) }),
      expect.anything(),
    ));
  });
});
