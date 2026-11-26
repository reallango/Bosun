import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
let own: string[] = [];
const stacksSpec = {
  list: 'stacks', deploy: 'stack_deploy', guard: 'stack_guard_up', export: 'export_compose',
  fields: { id: 'ID', name: 'name', project: 'compose', service: 'service', state: 'state' },
};
const loaded = { spec: { stacks: stacksSpec, actions: [{ id: 'stack_deploy' }, { id: 'stack_guard_up' }] } };

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: { query: async () => ({ values: [['docker_containers']] }) } }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => undefined }));
vi.mock('./self-import', () => ({
  beginSelfImport: async (r: { name: string; detach: boolean }) => { calls.push(`self-import ${r.name} detach=${r.detach}`); return true; },
  advanceSelfImport: async () => { calls.push('advance'); },
  cancelSelfImport: async () => undefined,
}));
vi.mock('@/lib/notifications/store', () => ({ notify: async (n: { title: string; message: string }) => { calls.push(`notify ${n.title}: ${n.message}`); } }));
vi.mock('@/lib/network/node-host', () => ({ ownContainerIds: () => own }));
vi.mock('@/lib/widgets/jobs/store', () => ({ getJob: async () => null }));
vi.mock('@/lib/widgets/runtime/execute', () => ({
  loadWidgetSpec: async () => loaded,
  loadRuntimeData: async () => ({ data: [
    { ID: 'aaa111', name: 'app-web-1', compose: 'app', service: 'web', state: 'running' },
    { ID: 'bbb222', name: 'bosun', compose: 'bosun', service: 'bosun', state: 'running' },
    { ID: 'ccc333', name: 'solo', compose: 'solo', service: 'solo', state: 'running' },
  ] }),
  loadDataset: async () => ({ data: [
    { name: 'app', source: 'editor' }, { name: 'bosun', source: 'git' }, { name: 'solo', source: 'editor' }, { name: 'ext', source: 'external' },
  ] }),
}));
vi.mock('@/lib/widgets/runtime/run-action', () => ({
  runWidgetAction: async (_a: unknown, _s: string, _l: unknown, action: { id: string }, body: { params: { name: string } }) => {
    calls.push(`${action.id} ${body.params.name}`);
    return new Response('{}', { status: 200 });
  },
}));
vi.mock('./client', () => ({
  getConnection: async () => ({ hasKey: true }),
  listStacks: async () => [
    { Id: 7, Name: 'app', EndpointId: 3, Env: [], GitConfig: null },
    { Id: 8, Name: 'bosun', EndpointId: 3, Env: [], GitConfig: { URL: 'https://github.com/x/y', ReferenceName: 'refs/heads/dev', ConfigFilePath: 'docker-compose.yaml' } },
    { Id: 9, Name: 'ext', EndpointId: 3, Env: [], GitConfig: null },
  ],
  deleteStack: async (_s: string, id: number, ep: number) => { calls.push(`portainer delete ${id}@${ep}`); },
  stackFile: async () => '',
}));

const auth = { userId: 'u1', role: 'admin' } as never;
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => { calls.length = 0; own = []; });

describe('stacks Bosun manages that Portainer still lists', () => {
  it('are offered for detaching; stacks only Bosun has, and unmanaged ones, are not', async () => {
    const { listCandidates } = await import('./import');
    const r = await listCandidates('s1');
    expect(r.detachable.map(d => d.name)).toEqual(['app', 'bosun']);
    expect(r.candidates.map(c => c.name)).toEqual(['ext']);
    expect(r.detachable.find(d => d.name === 'bosun')?.portainer.git?.branch).toBe('dev');
  });

  it('this Bosun\'s own stack is detached through the self-import record (the restarted process reports)', async () => {
    own = ['bbb222'];
    const { listCandidates, startDetach } = await import('./import');
    const d = (await listCandidates('s1')).detachable.find(x => x.name === 'bosun')!;
    expect(d).toMatchObject({ own: true, detachable: true });
    await startDetach(auth, 's1', 'bosun');
    await settle();
    expect(calls).toEqual(['self-import bosun detach=true', 'advance']);
  });

  it('detaching starts the waiter before Portainer deletes the stack, then reports in the bell', async () => {
    const { startDetach } = await import('./import');
    await startDetach(auth, 's1', 'app');
    await settle();
    expect(calls[0]).toBe('stack_guard_up app');
    expect(calls[1]).toBe('portainer delete 7@3');
    expect(calls[2]).toMatch(/^notify Detached app from Portainer: .*started again/);
  });

  it('a stack Portainer does not list, or Bosun does not manage, cannot be detached', async () => {
    const { startDetach } = await import('./import');
    await expect(startDetach(auth, 's1', 'solo')).rejects.toThrow(/does not manage a stack of that name/);
    await expect(startDetach(auth, 's1', 'ext')).rejects.toThrow(/does not manage a stack of that name/);
    expect(calls).toEqual([]);
  });
});
