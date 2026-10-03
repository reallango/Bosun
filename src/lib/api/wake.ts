import { fetchWithAuth } from './fetchWithAuth';

export interface WakeServerResult {
  success: boolean;
  via: 'container' | 'local_server';
  host?: string;
  mac: string;
  broadcast: string;
  port: number;
}

/** Error carrying the machine-readable code and install hint from the wake API. */
export class WakeError extends Error {
  code?: string;
  needsInstall: boolean;
  host?: string;

  constructor(message: string, opts: { code?: string; needsInstall?: boolean; host?: string } = {}) {
    super(message);
    this.name = 'WakeError';
    this.code = opts.code;
    this.needsInstall = opts.needsInstall ?? false;
    this.host = opts.host;
  }
}

/**
 * Send a Wake-on-LAN magic packet for a server.
 *
 * When a local server is configured and enabled, the packet is sent from that
 * host (over SSH) so it lands on the target's L2 segment; otherwise Bosun sends
 * it from its own container. An optional `broadcast` overrides the derived
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
  if (json.error) {
    throw new WakeError(json.error.message, {
      code: json.error.code,
      needsInstall: json.error.needs_install,
      host: json.error.host,
    });
  }
  return json.data as WakeServerResult;
}

/** Install the `wakeonlan` utility on the configured local server. */
export async function installWol(serverId: string): Promise<{ success: boolean; host: string }> {
  const res = await fetchWithAuth(`/api/servers/${serverId}/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'install' }),
  });
  const json = await res.json();
  if (json.error) throw new WakeError(json.error.message, { code: json.error.code });
  return json.data as { success: boolean; host: string };
}

export interface WolSettings {
  local_server_id: string | null;
  use_local_server: boolean;
  remote_wol_installed: boolean;
  local_server?: { id: string; name: string; hostname: string } | null;
}

/** Read the Wake-on-LAN configuration (local server + install cache). */
export async function getWolSettings(): Promise<WolSettings> {
  const res = await fetchWithAuth('/api/settings/wol');
  const json = await res.json();
  if (json.error) throw new WakeError(json.error.message, { code: json.error.code });
  return json.data as WolSettings;
}

/** Update the Wake-on-LAN configuration (admin only). */
export async function saveWolSettings(
  patch: { local_server_id?: string | null; use_local_server?: boolean }
): Promise<WolSettings> {
  const res = await fetchWithAuth('/api/settings/wol', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const json = await res.json();
  if (json.error) throw new WakeError(json.error.message, { code: json.error.code });
  return json.data as WolSettings;
}
