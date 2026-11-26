/**
 * The Portainer instance on a server, for importing its stacks into Bosun (Settings > Servers > a server > Portainer).
 *
 * Stored per server in app_config: `portainer.<serverId>` = { url, insecure, endpointId } and the API key encrypted with the
 * master key under `portainer.<serverId>.key`. The key is never sent to the browser. Requests go from Bosun's web app to the
 * address an admin entered (`insecure` accepts Portainer's default self-signed certificate) with the key in X-API-Key, and never
 * follow redirects.
 */
import http from 'http';
import https from 'https';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt, encrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';

export interface PortainerConnection { url: string; insecure: boolean; endpointId: number | null }
export interface PortainerStack {
  Id: number; Name: string; Type: number; EndpointId: number; Status?: number;
  Env?: { name: string; value: string }[] | null;
  GitConfig?: { URL?: string; ReferenceName?: string; ConfigFilePath?: string } | null;
}

export class PortainerError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'PORTAINER_ERROR') { super(message); }
}

const cfgKey = (serverId: string) => `portainer.${serverId}`;
const keyKey = (serverId: string) => `portainer.${serverId}.key`;

export function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function getConnection(serverId: string): Promise<(PortainerConnection & { hasKey: boolean }) | null> {
  const r = await rqlite.query('SELECT key, value FROM app_config WHERE key IN (?, ?)', [cfgKey(serverId), keyKey(serverId)]);
  const rows = new Map((r.values || []).map(v => [String(v[0]), String(v[1] ?? '')]));
  const raw = rows.get(cfgKey(serverId));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return { url: String(c.url), insecure: c.insecure === true, endpointId: Number.isInteger(c.endpointId) ? c.endpointId : null, hasKey: !!rows.get(keyKey(serverId)) };
  } catch {
    return null;
  }
}

async function apiKeyOf(serverId: string): Promise<string> {
  const r = await rqlite.query('SELECT value FROM app_config WHERE key = ?', [keyKey(serverId)]);
  const v = r.values?.[0]?.[0];
  if (typeof v !== 'string' || !v) throw new PortainerError('No Portainer API key is stored for this server', 409, 'PORTAINER_NOT_SET');
  try { return decrypt(v, getMasterKey()); } catch { throw new PortainerError('The stored Portainer API key cannot be read; enter it again', 409, 'PORTAINER_NOT_SET'); }
}

export async function saveConnection(serverId: string, c: PortainerConnection, apiKey?: string | null): Promise<void> {
  const stmts: { sql: string; params: unknown[] }[] = [{
    sql: `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    params: [cfgKey(serverId), JSON.stringify(c), 'Portainer on this server (for importing its stacks)'],
  }];
  if (apiKey) {
    stmts.push({
      sql: `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      params: [keyKey(serverId), encrypt(apiKey, getMasterKey()), 'Portainer API key of this server (encrypted)'],
    });
  }
  await rqlite.executeBatch(stmts, { transaction: true });
}

export async function deleteConnection(serverId: string): Promise<void> {
  await rqlite.execute('DELETE FROM app_config WHERE key IN (?, ?)', [cfgKey(serverId), keyKey(serverId)]);
}

/** One request to Portainer's API. Throws PortainerError with Portainer's own message when it answers with an error. */
export async function portainerRequest<T>(serverId: string, method: string, path: string, opts: { conn?: PortainerConnection; apiKey?: string; timeoutMs?: number } = {}): Promise<T> {
  const conn = opts.conn ?? await getConnection(serverId);
  if (!conn) throw new PortainerError('Portainer is not set up for this server', 409, 'PORTAINER_NOT_SET');
  const key = opts.apiKey ?? await apiKeyOf(serverId);
  const url = new URL(conn.url + path);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise<T>((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: { 'X-API-Key': key, Accept: 'application/json' },
      timeout: opts.timeoutMs ?? 15_000,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: !conn.insecure } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => { size += d.length; if (size <= 4_000_000) chunks.push(d); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve(body as T);
        const msg = (body && typeof body === 'object' && ('message' in body || 'details' in body))
          ? String((body as Record<string, unknown>).message ?? '') + ((body as Record<string, unknown>).details ? `: ${(body as Record<string, unknown>).details}` : '')
          : `HTTP ${status}`;
        reject(new PortainerError(`Portainer answered: ${msg}`.slice(0, 300), status === 401 || status === 403 ? 409 : 502, status === 401 || status === 403 ? 'PORTAINER_AUTH' : 'PORTAINER_ERROR'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      const hint = /self[- ]signed|certificate/i.test(e.message) ? ' (Portainer uses a self-signed certificate: tick "Accept a self-signed certificate")' : '';
      reject(new PortainerError(`Cannot reach Portainer at ${conn.url}: ${e.message}${hint}`, 502, 'PORTAINER_UNREACHABLE'));
    });
    req.end();
  });
}

export async function listEndpoints(serverId: string, conn: PortainerConnection, apiKey?: string): Promise<{ Id: number; Name: string; Type: number }[]> {
  const eps = await portainerRequest<{ Id: number; Name: string; Type: number }[]>(serverId, 'GET', '/api/endpoints', { conn, apiKey });
  return (Array.isArray(eps) ? eps : []).map(e => ({ Id: Number(e.Id), Name: String(e.Name), Type: Number(e.Type) }));
}

/** Compose stacks (Type 2) of the configured environment. */
export async function listStacks(serverId: string): Promise<PortainerStack[]> {
  const conn = await getConnection(serverId);
  if (!conn) throw new PortainerError('Portainer is not set up for this server', 409, 'PORTAINER_NOT_SET');
  const stacks = await portainerRequest<PortainerStack[]>(serverId, 'GET', '/api/stacks', { conn });
  return (Array.isArray(stacks) ? stacks : []).filter(s => s.Type === 2 && (conn.endpointId === null || s.EndpointId === conn.endpointId));
}

export async function stackFile(serverId: string, id: number): Promise<string> {
  const r = await portainerRequest<{ StackFileContent?: string }>(serverId, 'GET', `/api/stacks/${id}/file`);
  if (typeof r?.StackFileContent !== 'string') throw new PortainerError('Portainer did not return the compose file');
  return r.StackFileContent;
}

/** Remove a stack from Portainer. NOTE: Portainer stops and removes its containers first ("docker compose down", volumes kept). */
export async function deleteStack(serverId: string, id: number, endpointId: number): Promise<void> {
  await portainerRequest<unknown>(serverId, 'DELETE', `/api/stacks/${id}?endpointId=${endpointId}`, { timeoutMs: 120_000 });
}
