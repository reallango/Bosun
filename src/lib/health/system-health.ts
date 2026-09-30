import { rqlite } from '../db/rqlite-client';
import { getDatabaseHealth, DatabaseHealth } from './db-health';

export type ComponentStatus = 'ok' | 'error' | 'unknown';

export interface ComponentHealth {
  name: string;
  status: ComponentStatus;
  detail: string;
}

export interface SystemHealth {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  app: {
    version: string;
    nodeVersion: string;
    uptimeSec: number;
    nodeId: string | null;
  };
  components: ComponentHealth[];
  database: DatabaseHealth;
}

async function probeHttp(url: string): Promise<{ status: ComponentStatus; detail: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok
      ? { status: 'ok', detail: `HTTP ${res.status}` }
      : { status: 'error', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'error', detail: String(err) };
  }
}

async function checkWebsocket(): Promise<ComponentHealth> {
  const port = process.env.WS_PORT || '3002';
  const { status, detail } = await probeHttp(`http://localhost:${port}/health`);
  return { name: 'websocket', status, detail };
}

async function checkPoller(): Promise<ComponentHealth> {
  const port = process.env.POLLER_HEALTH_PORT || '3003';
  const { status, detail } = await probeHttp(`http://localhost:${port}/health`);
  return { name: 'poller', status, detail };
}

async function checkSshFleet(): Promise<ComponentHealth> {
  try {
    const result = await rqlite.query('SELECT COUNT(*), SUM(is_online) FROM servers');
    const total = Number(result.values[0]?.[0] ?? 0);
    const online = Number(result.values[0]?.[1] ?? 0);
    const status: ComponentStatus = total === 0 ? 'unknown' : online === total ? 'ok' : 'error';
    return { name: 'ssh-fleet', status, detail: `${online}/${total} servers online` };
  } catch (err) {
    return { name: 'ssh-fleet', status: 'error', detail: String(err) };
  }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const database = await getDatabaseHealth();

  const [websocket, poller, sshFleet] = await Promise.all([
    checkWebsocket(),
    checkPoller(),
    checkSshFleet(),
  ]);

  const components: ComponentHealth[] = [
    { name: 'database', status: database.ready ? 'ok' : 'error', detail: `status: ${database.status}` },
    websocket,
    poller,
    sshFleet,
  ];

  const hasError = components.some(c => c.status === 'error');
  const status: SystemHealth['status'] =
    database.status === 'error' || hasError
      ? 'error'
      : database.status === 'degraded'
        ? 'degraded'
        : 'ok';

  return {
    status,
    timestamp: new Date().toISOString(),
    app: {
      version: process.env.npm_package_version || '0.1.0',
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      nodeId: database.nodeId,
    },
    components,
    database,
  };
}
