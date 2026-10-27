'use client';

import { useCallback, useEffect, useState } from 'react';
import { Power } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { getWolSettings, saveWolSettings, WolSettings } from '@/lib/api/wake';

interface ServerOption { id: string; name: string; host: string }

const SENDER_HELP: Record<WolSettings['sender'], string> = {
  auto: 'Send from the server this Bosun node runs on (over SSH), so each node in a cluster uses its own host. Falls back to the container if that host is unknown or unreachable.',
  local_server: 'Always send from one chosen server over SSH.',
  container: 'Send from the Bosun container itself. Only reaches machines on the same network segment as the container (host networking).',
};

/**
 * Wake-on-LAN sender settings. A magic packet only reaches a sleeping machine
 * from the same L2 segment, so it is normally sent over SSH from a managed
 * host rather than from the (bridged) Bosun container.
 */
export default function WakeOnLanCard() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [s, setS] = useState<WolSettings | null>(null);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await getWolSettings());
    } catch (err) {
      toast('Failed to load Wake-on-LAN settings', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  }, [toast]);

  useEffect(() => {
    load();
    fetchWithAuth('/api/servers')
      .then(r => readJson<{ data?: { servers?: ServerOption[] } }>(r))
      .then(j => setServers(j.data?.servers || []))
      .catch(() => undefined);
  }, [load]);

  const save = async (patch: Parameters<typeof saveWolSettings>[0]) => {
    setSaving(true);
    try {
      setS(await saveWolSettings(patch));
    } catch (err) {
      toast('Could not save', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Power className="size-4" aria-hidden /> Wake-on-LAN</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!s ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <fieldset disabled={!isAdmin || saving} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wol-sender">Send magic packets from</Label>
              <select id="wol-sender" className="form-select" value={s.sender}
                onChange={e => save({ sender: e.target.value as WolSettings['sender'] })}>
                <option value="auto">The host this Bosun node runs on (recommended)</option>
                <option value="local_server">A fixed server</option>
                <option value="container">The Bosun container</option>
              </select>
              <p className="text-xs text-muted-foreground">{SENDER_HELP[s.sender]}</p>
            </div>

            {s.sender === 'auto' && (
              <div className="space-y-1.5 rounded-md border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">Host of node <code className="rounded bg-muted px-1 text-xs">{s.node_name}</code></span>
                  <span className="text-xs text-muted-foreground">
                    Detected: {s.node_host_detected ? s.node_host_detected.name : 'not found (add the Docker host as a server)'}
                  </span>
                </div>
                <select aria-label="Host of this node" className="form-select" value={s.node_host_mapped?.id || ''}
                  onChange={e => save({ node_host_server_id: e.target.value || null })}>
                  <option value="">Detect automatically{s.node_host_detected ? ` (${s.node_host_detected.name})` : ''}</option>
                  {servers.map(o => <option key={o.id} value={o.id}>{o.name} ({o.host})</option>)}
                </select>
                <p className="text-xs text-muted-foreground">
                  Detection matches this container against the Docker containers Bosun sees on each server. Set it here if the
                  host is not monitored by Docker or detection picks the wrong one. Each node of a cluster keeps its own setting.
                </p>
              </div>
            )}

            {s.sender === 'local_server' && (
              <div className="space-y-1.5">
                <Label htmlFor="wol-local">Server that sends the packets</Label>
                <select id="wol-local" className="form-select" value={s.local_server_id || ''}
                  onChange={e => save({ local_server_id: e.target.value || null })}>
                  <option value="">-- Select a server --</option>
                  {servers.map(o => <option key={o.id} value={o.id}>{o.name} ({o.host})</option>)}
                </select>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Currently sending from:{' '}
              <span className="font-medium text-foreground">
                {s.effective_sender ? `${s.effective_sender.name} (${s.effective_sender.source})` : 'the Bosun container'}
              </span>
              {s.effective_sender && (s.remote_wol_installed ? ' · wakeonlan found' : ' · wakeonlan not confirmed yet (the first wake checks it)')}
            </p>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
