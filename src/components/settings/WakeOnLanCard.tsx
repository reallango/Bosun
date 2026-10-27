'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { getWolSettings, saveWolSettings, installWol, WakeError } from '@/lib/api/wake';

interface ServerOption {
  id: string;
  name: string;
  host: string;
}

/**
 * Wake-on-LAN settings.
 *
 * A magic packet only reaches a powered-off host from the same L2 segment, which
 * the Bosun container usually is not. This card picks a managed server (normally
 * the Docker host) whose SSH credentials Bosun uses to run `wakeonlan`, and can
 * install the utility on that host.
 */
export default function WakeOnLanCard() {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [localServerId, setLocalServerId] = useState('');
  const [useLocalServer, setUseLocalServer] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, serversRes] = await Promise.all([
        getWolSettings(),
        fetchWithAuth('/api/servers').then(r => r.json()),
      ]);
      setLocalServerId(settings.local_server_id || '');
      setUseLocalServer(settings.use_local_server);
      setInstalled(settings.remote_wol_installed);
      if (serversRes.data) {
        const raw: ServerOption[] = serversRes.data.servers || serversRes.data;
        setServers(raw.map(s => ({ id: s.id, name: s.name, host: s.host })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Wake-on-LAN settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next = await saveWolSettings({ local_server_id: localServerId || null, use_local_server: useLocalServer });
      setInstalled(next.remote_wol_installed);
      setMessage('Saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleInstall = async () => {
    if (!localServerId) {
      setError('Pick a local server first.');
      return;
    }
    setInstalling(true);
    setMessage(null);
    setError(null);
    try {
      const res = await installWol(localServerId);
      setInstalled(true);
      setMessage(`wakeonlan installed on ${res.host}`);
    } catch (err) {
      const msg = err instanceof WakeError ? err.message : err instanceof Error ? err.message : 'Install failed';
      setError(msg);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wake-on-LAN</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            {message && <div className="text-sm text-success">{message}</div>}

            <div>
              <Label className="mb-1">Local server</Label>
              <select
                value={localServerId}
                onChange={e => setLocalServerId(e.target.value)}
                className="form-select"
              >
                <option value="">-- None --</option>
                {servers.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                The host that sends magic packets on its own subnet (usually the Docker host).
              </p>
            </div>

            <div>
              <Label className="mb-1">Use the local server</Label>
              <select
                value={useLocalServer ? 'true' : 'false'}
                onChange={e => setUseLocalServer(e.target.value === 'true')}
                className="form-select"
              >
                <option value="false">Disabled - send from the Bosun container</option>
                <option value="true">Enabled - run wakeonlan on the local server</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Enable when the Bosun container is not on the same L2 segment as the target.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
              <Button variant="outline" onClick={handleInstall} disabled={installing || !localServerId}>
                {installing ? 'Installing...' : 'Install wakeonlan'}
              </Button>
              <span className={`text-xs px-2 py-1 rounded ${installed ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                {installed ? 'wakeonlan installed' : 'not installed'}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
