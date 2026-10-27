import { fetchWithAuth } from './fetchWithAuth';
import type { PowerAction } from '@/lib/ssh/power';

export type { PowerAction };

/** Shut down or restart a server. Throws the API's error message on failure. */
export async function powerServer(serverId: string, action: PowerAction): Promise<void> {
  const res = await fetchWithAuth(`/api/servers/${serverId}/power`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, confirm: true }),
  });
  let json: { error?: { message?: string } } = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.error) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
}
