'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface WidgetPollingConfig {
  id: string;
  widget_type: string;
  server_id: string;
  poll_interval_sec: number | null;
  ttl_sec: number | null;
  storage_mode: string;
  enabled: number;
  last_polled_at: string | null;
}

export default function WidgetSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const widgetId = params.widgetId as string;

  const [config, setConfig] = useState<WidgetPollingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form fields
  const [pollInterval, setPollInterval] = useState<string>('');
  const [ttl, setTtl] = useState<string>('');
  const [storageMode, setStorageMode] = useState<string>('latest_ttl');
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    if (widgetId) {
      fetchConfig();
    }
  }, [widgetId]);

  const fetchConfig = async () => {
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/settings`);
      const data = await res.json();
      if (data.data?.config) {
        const c = data.data.config;
        setConfig(c);
        setPollInterval(c.poll_interval_sec?.toString() || '');
        setTtl(c.ttl_sec?.toString() || '');
        setStorageMode(c.storage_mode || 'latest_ttl');
        setEnabled(c.enabled === 1);
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poll_interval_sec: pollInterval ? parseInt(pollInterval) : null,
          ttl_sec: ttl ? parseInt(ttl) : null,
          storage_mode: storageMode,
          enabled: enabled ? 1 : 0,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else if (data.error) {
        alert('Failed: ' + data.error.message);
      }
    } catch (err) {
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Header title="Widget Settings" />
        <div className="p-8">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Header title="Widget Settings" />
      <div className="max-w-2xl mx-auto p-8">
        <div className="mb-6">
          <Button variant="ghost" onClick={() => router.back()}>
            ← Back
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Widget Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Poll Interval (seconds)</Label>
              <Input
                value={pollInterval}
                onChange={(e) => setPollInterval(e.target.value)}
                placeholder="e.g., 30 (leave empty for default)"
              />
              <p className="text-xs text-gray-500 mt-1">
                How often to refresh this widget in the background. Leave empty to use widget default.
              </p>
            </div>

            <div>
              <Label>Cache TTL (seconds)</Label>
              <Input
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                placeholder="e.g., 300 (leave empty for default)"
              />
              <p className="text-xs text-gray-500 mt-1">
                How long to keep cached data before it expires.
              </p>
            </div>

            <div>
              <Label>Storage Mode</Label>
              <select
                className="w-full mt-1 px-3 py-2 border rounded bg-white dark:bg-gray-800"
                value={storageMode}
                onChange={(e) => setStorageMode(e.target.value)}
              >
                <option value="latest_ttl">Latest TTL (keep newest, expire after TTL)</option>
                <option value="change_only">Change Only (only store when data changes)</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="enabled">Enable background polling</Label>
            </div>

            <div className="pt-4 flex gap-2">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              {saved && (
                <span className="text-green-600 self-center text-sm">Saved!</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}