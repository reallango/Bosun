'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import type { SettingDef } from '@/lib/settings-schema';

interface SettingsResponse {
  settings: SettingDef[];
  values: Record<string, string | null>;
}

export default function AppSettingsCard() {
  const [settings, setSettings] = useState<SettingDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/db/settings');
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);

      const data = json.data as SettingsResponse;
      setSettings(data.settings);
      const initial: Record<string, string> = {};
      for (const def of data.settings) {
        initial[def.key] = data.values[def.key] ?? '';
      }
      setValues(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
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
      const res = await fetchWithAuth('/api/db/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setMessage('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {error && (
              <div className="md:col-span-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {settings.map(def => (
              <div key={def.key}>
                <Label htmlFor={`setting-${def.key}`} className="mb-1.5">{def.label}</Label>
                {def.type === 'boolean' ? (
                  <select
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                    id={`setting-${def.key}`}
                    className="form-select"
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                ) : def.options ? (
                  <select
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                    id={`setting-${def.key}`}
                    className="form-select"
                  >
                    {def.options.map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`setting-${def.key}`}
                    type={def.type === 'number' ? 'number' : 'text'}
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                  />
                )}
                <p className="mt-1 text-xs text-muted-foreground">{def.description}</p>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <Button size="lg" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
              {message && <span className="text-sm text-success" role="status">{message}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
