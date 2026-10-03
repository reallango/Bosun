import { fetchWithAuth } from './fetchWithAuth';

export interface WakeServerResult {
  success: boolean;
  mac: string;
  broadcast: string;
  port: number;
}

/**
 * Send a Wake-on-LAN magic packet for a server.
 *
 * The packet goes out from the Bosun host, so the target MAC must sit on a
 * subnet Bosun can reach. An optional `broadcast` overrides the derived
 * subnet-broadcast address, and an optional `mac_address` overrides the value
 * stored on the server (neither is persisted).
 */
export async function wakeServer(
  serverId: string,
  options: { broadcast?: string; mac_address?: string } = {}
): Promise<WakeServerResult> {
  const res = await fetchWithAuth(`/api/servers/${serverId}/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.data as WakeServerResult;
}
