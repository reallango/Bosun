import { describe, it, expect, vi, beforeEach } from 'vitest';

const config = new Map<string, string>();
const actions: Array<{ id: string; params: Record<string, unknown> }> = [];
const notices: string[] = [];
let stacks: Array<{ name: string }> = [];
let containers: Array<Record<string, unknown>> = [];
let nodeRows: Array<{ key: string; value: string }> = [];
let me = 'nuc';
let nodes: Array<{ id: string; addr: string; api_addr: string | null; voter: boolean; reachable: boolean }> = [];
let clusterReady = true;
let dockerError: string | null = null;
const fetched: Array<{ url: string; body?: unknown }> = [];

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { rows: unknown[] }) => r.rows,
  rqlite: {
    query: async (sql: string, params: unknown[]) => ({
      rows: sql.includes('FROM servers') && params[0] === 's1' ? [{ id: 's1', name: 'Fresh Box', hostname: '192.168.1.170', platform: 'linux' }]
        : sql.includes('app_config') && sql.includes('update.node.') ? nodeRows : [],
    }),
    execute: async (_sql: string, [key, value]: [string, string]) => { config.set(key, value); return { rows_affected: 1 }; },
    getNodes: async () => nodes,
  },
}));
vi.mock('@/lib/network/node-host', () => ({ nodeName: () => me, detectNodeHost: async () => null, ownContainerIds: () => [] }));
vi.mock('@/lib/db/migrations', () => ({ getConfig: async (k: string) => config.get(k) ?? null }));
vi.mock('@/lib/audit/logger', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/notifications/store', () => ({ notify: async (n: { title: string }) => { notices.push(n.title); return true; } }));
vi.mock('@/lib/cluster/config', () => ({
  isValidHost: (h: string) => /^[A-Za-z0-9.:-]+$/.test(h), isValidNodeId: (n: string) => /^[A-Za-z0-9._-]{1,64}$/.test(n),
  effectiveClusterConfig: () => ({ cluster_ready: clusterReady }),
}));
vi.mock('@/lib/cluster/control', () => ({ createJoinCode: async () => ({ code: 'BOSUN-JOIN-2.test' }) }));
vi.mock('@/lib/update/rollout', () => ({ getUpdateConfig: async () => ({ image: 'ghcr.io/o/bosun', channel: 'dev', webPort: 3042 }) }));
vi.mock('@/lib/widgets/jobs/store', () => ({ getJob: async () => ({ status: 'success', message: 'deployed bosun' }) }));
vi.mock('@/lib/widgets/runtime/execute', () => ({
  loadDataset: async () => { if (dockerError) throw new Error(dockerError); return { data: stacks }; },
  loadRuntimeData: async () => { if (dockerError) throw new Error(dockerError); return { data: containers }; },
}));
vi.mock('@/lib/widgets/runtime/run-action', () => ({
  runWidgetAction: async (_a: unknown, _s: string, _l: unknown, action: { id: string }, body: { params: Record<string, unknown> }) => {
    actions.push({ id: action.id, params: body.params });
    return new Response(JSON.stringify({ data: { jobId: 'j1' } }), { status: 202 });
  },
}));
vi.mock('@/lib/portainer/import', () => ({
  stackManager: async () => ({
    spec: {
      stacks: { list: 'stacks', deploy: 'stack_deploy', fields: { id: 'ID', name: 'name', state: 'state', project: 'compose', service: 'service' } },
      actions: [{ id: 'stack_deploy' }],
    },
  }),
}));

const auth = { userId: 'u1', username: 'lango', role: 'admin', authType: 'session' } as never;
const settle = async (until: () => boolean) => { for (let i = 0; i < 100 && !until(); i++) await new Promise(r => setTimeout(r, 10)); };

beforeEach(() => {
  config.clear(); actions.length = 0; notices.length = 0; fetched.length = 0;
  stacks = []; containers = []; nodeRows = []; me = 'nuc';
  nodes = [{ id: 'nuc', addr: '192.168.1.161:4002', api_addr: 'http://192.168.1.161:4001', voter: true, reachable: true }]; clusterReady = true; dockerError = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    fetched.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/setup/join')) { nodes = [...nodes, { id: 'fresh-box', addr: '192.168.1.170:4002', api_addr: null, voter: true, reachable: true }]; return new Response('{}', { status: 200 }); }
    return new Response('{"status":"ok"}', { status: 200 });
  }));
});

describe('the compose file of a deployed Bosun', () => {
  it('uses the published image, keeps data in a volume, and publishes the cluster ports only to join', async () => {
    const { bosunCompose, nodeNameFrom } = await import('./deploy-bosun');
    const join = bosunCompose({ image: 'ghcr.io/o/bosun:dev', webPort: 3042, join: true });
    expect(join).toContain('image: ghcr.io/o/bosun:dev');
    expect(join).toContain('- bosun-data:/data/rqlite');
    expect(join).toMatch(/"3042:3042"[\s\S]*"4001:4001"[\s\S]*"4002:4002"/);
    expect(join).not.toMatch(/build:|privileged|docker\.sock/);
    const solo = bosunCompose({ image: 'ghcr.io/o/bosun:dev', webPort: 8080, join: false });
    expect(solo).toContain('"8080:3042"');
    expect(solo).not.toContain('4001');
    expect(nodeNameFrom('Fresh Box #2')).toBe('fresh-box-2');
    expect(nodeNameFrom('***')).toBe('node');
  });
});

describe('deploying Bosun to a server', () => {
  it('joins: deploys the stack, waits for it, redeems a join code on it, and waits until it is a member', async () => {
    const { startBosunDeploy, getDeploy } = await import('./deploy-bosun');
    const d = await startBosunDeploy(auth, 's1', { mode: 'join' });
    expect(d).toMatchObject({ status: 'running', node_name: 'fresh-box', image: 'ghcr.io/o/bosun:dev', web: 'http://192.168.1.170:3042' });
    expect(actions[0].id).toBe('stack_deploy');
    expect(actions[0].params).toMatchObject({ name: 'bosun', source: 'editor', pull: true });
    await settle(() => notices.length > 0);
    expect(fetched.find(f => f.url.endsWith('/api/setup/join'))?.body).toEqual({ code: 'BOSUN-JOIN-2.test', adv_host: '192.168.1.170', node_id: 'fresh-box' });
    expect(notices).toEqual(['Bosun node fresh-box joined the cluster']);
    expect((await getDeploy('s1'))?.status).toBe('done');
  });

  it('standalone: no join code, and it says where to create the admin account', async () => {
    const { startBosunDeploy, getDeploy } = await import('./deploy-bosun');
    await startBosunDeploy(auth, 's1', { mode: 'standalone' });
    await settle(() => notices.length > 0);
    expect(fetched.some(f => f.url.endsWith('/api/setup/join'))).toBe(false);
    expect(String(actions[0].params.yaml)).not.toContain('4001');
    expect(notices).toEqual(['Bosun is running on the new server']);
    expect((await getDeploy('s1'))?.message).toMatch(/create its admin account/);
  });

  it('refuses what cannot work, before anything runs', async () => {
    const { startBosunDeploy } = await import('./deploy-bosun');
    dockerError = 'Docker is not available to this account';
    await expect(startBosunDeploy(auth, 's1', { mode: 'join' })).rejects.toThrow(/Docker is not ready/);
    dockerError = null;
    stacks = [{ name: 'bosun' }];
    await expect(startBosunDeploy(auth, 's1', { mode: 'join' })).rejects.toThrow(/already runs Bosun: stack bosun/);
    stacks = [];
    clusterReady = false;
    await expect(startBosunDeploy(auth, 's1', { mode: 'join' })).rejects.toThrow(/not a cluster yet/);
    clusterReady = true;
    await expect(startBosunDeploy(auth, 's1', { mode: 'join', nodeName: 'nuc' })).rejects.toThrow(/already has a node called "nuc"/);
    await expect(startBosunDeploy(auth, 's1', { mode: 'join', nodeName: 'bad name!' })).rejects.toThrow(/Node name/);
    await expect(startBosunDeploy(auth, 'nope', { mode: 'join' })).rejects.toThrow(/Server not found/);
    expect(actions).toEqual([]);
  });

  it('only one deployment at a time per server', async () => {
    const { startBosunDeploy } = await import('./deploy-bosun');
    config.set('deploy.bosun.s1', JSON.stringify({ status: 'running', started_at: new Date().toISOString() }));
    await expect(startBosunDeploy(auth, 's1', { mode: 'standalone' })).rejects.toThrow(/already being deployed/);
  });
});

describe('whether Bosun already runs on a server', () => {
  it('detects the node of this cluster that runs there, and says whether it is this one', async () => {
    const { detectBosunRunning } = await import('./deploy-bosun');
    nodeRows = [{ key: 'update.node.nuc', value: JSON.stringify({ server_id: 's1', container_id: null, commit: 'abc', at: 'now' }) }];
    me = 'nuc';
    expect(await detectBosunRunning('s1')).toEqual({ running: { kind: 'node', node: 'nuc', self: true, web: 'http://192.168.1.161:3042' }, check_error: null });
    me = 'another';
    expect(await detectBosunRunning('s1')).toEqual({ running: { kind: 'node', node: 'nuc', self: false, web: 'http://192.168.1.161:3042' }, check_error: null });
  });

  it('detects a stack called bosun', async () => {
    const { detectBosunRunning } = await import('./deploy-bosun');
    stacks = [{ name: 'bosun' }];
    expect(await detectBosunRunning('s1')).toEqual({ running: { kind: 'stack', name: 'bosun' }, check_error: null });
  });

  it('detects a container running the configured image (any tag) or bosun:*', async () => {
    const { detectBosunRunning } = await import('./deploy-bosun');
    stacks = [{ name: 'web' }];
    containers = [{ ID: 'c1', name: 'bosun', compose: 'web', service: 'bosun', state: 'running', image: 'ghcr.io/o/bosun:sha-abcdef0' }];
    expect(await detectBosunRunning('s1')).toEqual({ running: { kind: 'stack', name: 'web' }, check_error: null });
    containers = [{ ID: 'c2', name: 'bosun', compose: 'bosun', service: 'bosun', state: 'running', image: 'bosun:latest' }];
    expect(await detectBosunRunning('s1')).toEqual({ running: { kind: 'stack', name: 'bosun' }, check_error: null });
  });

  it('finds nothing on a server that does not run Bosun', async () => {
    const { detectBosunRunning } = await import('./deploy-bosun');
    stacks = [{ name: 'web' }];
    containers = [{ ID: 'c1', name: 'web', compose: 'web', service: 'web', state: 'running', image: 'nginx:latest' }];
    expect(await detectBosunRunning('s1')).toEqual({ running: null, check_error: null });
  });

  it('says why when the server cannot be asked', async () => {
    const { detectBosunRunning } = await import('./deploy-bosun');
    dockerError = 'Docker is not available to this account';
    expect(await detectBosunRunning('s1')).toEqual({ running: null, check_error: 'Docker is not available to this account' });
  });

  it('refuses to deploy to a node or to a stack already running Bosun', async () => {
    const { startBosunDeploy } = await import('./deploy-bosun');
    nodeRows = [{ key: 'update.node.nuc', value: JSON.stringify({ server_id: 's1', container_id: null, commit: 'abc', at: 'now' }) }];
    await expect(startBosunDeploy(auth, 's1', { mode: 'join' })).rejects.toThrow(/already runs Bosun: it is node nuc/);
    nodeRows = [];
    stacks = [{ name: 'web' }];
    containers = [{ ID: 'c1', name: 'bosun', compose: 'web', service: 'bosun', state: 'running', image: 'ghcr.io/o/bosun:dev' }];
    await expect(startBosunDeploy(auth, 's1', { mode: 'standalone' })).rejects.toThrow(/already runs Bosun: stack web/);
    expect(actions).toEqual([]);
  });
});
