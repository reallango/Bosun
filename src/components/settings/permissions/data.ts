'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

export interface PermissionDef {
  id: string;
  label: string;
  description: string;
  group: string;
  defaultLevel: 'viewer' | 'operator' | 'admin';
  risk: 'low' | 'medium' | 'high';
  scope: 'server' | 'global';
  implies?: string[];
  source: string;
}

export type GrantScope = { type: 'all' } | { type: 'server'; id: string } | { type: 'server_group'; id: string };
export interface Grant { permission: string; scope: GrantScope; effect?: 'allow' | 'deny' }

export interface PermissionGroup {
  id: string;
  name: string;
  description: string | null;
  grants: Grant[];
  user_count: number;
  api_key_count: number;
}

export interface ServerGroup {
  id: string;
  name: string;
  description: string | null;
  server_ids: string[];
}

export interface ServerLite { id: string; name: string }

export interface PermissionData {
  catalog: PermissionDef[];
  groups: PermissionGroup[];
  serverGroups: ServerGroup[];
  servers: ServerLite[];
}

async function get<T>(url: string, pick: (d: any) => T): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const json = await readJson<{ data?: unknown; error?: { message?: string } }>(await fetchWithAuth(url));
  if (json.error || json.data === undefined) throw new Error(json.error?.message || `Could not load ${url}`);
  return pick(json.data);
}

/** Loads the catalog, groups, server groups and servers the permission screens need. */
export function usePermissionData(): { data: PermissionData | null; loading: boolean; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<PermissionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [catalog, groups, serverGroups, servers] = await Promise.all([
        get('/api/permissions', d => d.permissions as PermissionDef[]),
        get('/api/permission-groups', d => d.groups as PermissionGroup[]),
        get('/api/server-groups', d => d.groups as ServerGroup[]),
        get('/api/servers', d => (d.servers as Array<{ id: string; name: string }>).map(s => ({ id: s.id, name: s.name }))),
      ]);
      setData({ catalog, groups, serverGroups, servers });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload };
}

/** Plain-English summary of a grant's scope. */
export function scopeLabel(g: Grant, servers: ServerLite[], serverGroups: ServerGroup[]): string {
  if (g.scope.type === 'all') return 'all servers';
  if (g.scope.type === 'server') {
    const id = g.scope.id;
    return servers.find(s => s.id === id)?.name ?? 'a removed server';
  }
  const id = g.scope.id;
  const grp = serverGroups.find(s => s.id === id);
  return grp ? `group ${grp.name}` : 'a removed group';
}

/** Save helper: POST/PATCH/PUT/DELETE JSON and throw the API's message on failure. */
export async function send(url: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<unknown> {
  const res = await fetchWithAuth(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: { data?: unknown; error?: { message?: string } } = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.error) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
  return json.data;
}
