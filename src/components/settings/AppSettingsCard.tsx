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
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : (
          <>
            {error && (
              <div className="p-3 rounded bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-sm">
                {error}
              </div>
            )}
            {settings.map(def => (
              <div key={def.key}>
                <Label className="mb-1">{def.label}</Label>
                {def.type === 'boolean' ? (
                  <select
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                    className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                ) : def.options ? (
                  <select
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                    className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                  >
                    {def.options.map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={def.type === 'number' ? 'number' : 'text'}
                    value={values[def.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [def.key]: e.target.value }))}
                  />
                )}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{def.description}</p>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
              {message && <span className="text-sm text-green-600">{message}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
