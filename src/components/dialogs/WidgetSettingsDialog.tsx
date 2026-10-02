'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';
import { WidgetConfigField } from '@/types/widget';

interface WidgetSettingsDialogProps {
  widgetId: string;
  widgetType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: () => void;
}

export function WidgetSettingsDialog({ widgetId, widgetType, open, onOpenChange, onSave }: WidgetSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<any>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [configSchema, setConfigSchema] = useState<WidgetConfigField[]>([]);
  const [useDatabase, setUseDatabase] = useState(true);
  const [selectedSize, setSelectedSize] = useState<SizePreset | null>(null);

  useEffect(() => {
    if (open && widgetId) {
      setLoading(true);
      fetchWithAuth(`/api/widgets/${widgetId}/settings`)
        .then(r => r.json())
        .then(json => {
          if (json.data) {
            setData(json.data);
            setConfig((json.data.config as Record<string, unknown>) || {});
            setConfigSchema(Array.isArray(json.data.config_schema) ? json.data.config_schema : []);
            setUseDatabase(json.data.use_database !== 0);
            // Find matching size preset or set to null
            const gridW = json.data.grid_w;
            const gridH = json.data.grid_h;
            const matchingPreset = SIZE_PRESETS.find(p => p.gridW === gridW && p.gridH === gridH);
            setSelectedSize(matchingPreset || null);
          }
        })
        .finally(() => setLoading(false));
    }
  }, [open, widgetId]);

  const setConfigValue = (key: string, value: unknown) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...data };
      payload.config = config;
      payload.use_database = useDatabase ? 1 : 0;
      // Always include grid_w and grid_h - use selectedSize if available, otherwise use current values from data
      if (selectedSize) {
        payload.grid_w = selectedSize.gridW;
        payload.grid_h = selectedSize.gridH;
      } else if (data?.grid_w !== undefined) {
        payload.grid_w = data.grid_w;
        payload.grid_h = data.grid_h;
      }
      await fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (onSave) onSave();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4">Widget Settings</h2>

        {loading ? (
          <p>Loading...</p>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Display Name</Label>
              <Input
                value={data?.display_name || ''}
                onChange={e => setData({ ...data, display_name: e.target.value })}
                placeholder="Optional custom name"
              />
            </div>

            {/* Widget-specific config fields (custom widgets declare these). */}
            {configSchema.map(field => (
              <div key={field.key}>
                <Label>{field.label}</Label>
                {field.type === 'boolean' ? (
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="checkbox"
                      id={`cfg-${field.key}`}
                      checked={config[field.key] === true || config[field.key] === 'true'}
                      onChange={e => setConfigValue(field.key, e.target.checked)}
                    />
                    {field.description && <span className="text-xs text-muted-foreground">{field.description}</span>}
                  </div>
                ) : field.type === 'select' ? (
                  <select
                    className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                    value={String(config[field.key] ?? field.default ?? '')}
                    onChange={e => setConfigValue(field.key, e.target.value)}
                  >
                    {(field.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <Input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={String(config[field.key] ?? '')}
                    placeholder={field.placeholder}
                    onChange={e => setConfigValue(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                  />
                )}
                {field.description && field.type !== 'boolean' && (
                  <p className="text-xs text-muted-foreground mt-1">{field.description}</p>
                )}
              </div>
            ))}

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="use-database"
                checked={useDatabase}
                onChange={e => setUseDatabase(e.target.checked)}
              />
              <Label htmlFor="use-database">Store data in database</Label>
            </div>

            <div>
              <Label>Poll Interval (seconds)</Label>
              <Input
                type="number"
                value={data?.poll_interval_sec || ''}
                onChange={e => setData({ ...data, poll_interval_sec: parseInt(e.target.value) || null })}
                placeholder="30"
                disabled={!useDatabase}
              />
            </div>

            <div>
              <Label>TTL (seconds)</Label>
              <Input
                type="number"
                value={data?.ttl_sec || ''}
                onChange={e => setData({ ...data, ttl_sec: parseInt(e.target.value) || null })}
                placeholder="300"
                disabled={!useDatabase}
              />
            </div>

            <div>
              <Label>Storage Mode</Label>
              <select
                className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                value={data?.storage_mode || 'latest_ttl'}
                onChange={e => setData({ ...data, storage_mode: e.target.value })}
                disabled={!useDatabase}
              >
                <option value="latest_ttl">Latest TTL</option>
                <option value="change_only">Change Only</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enabled"
                checked={data?.enabled !== 0}
                onChange={e => setData({ ...data, enabled: e.target.checked ? 1 : 0 })}
              />
              <Label htmlFor="enabled">Enable polling</Label>
            </div>

            <div>
              <Label>Size</Label>
              <select
                className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                value={selectedSize?.id || 'custom'}
                onChange={e => {
                  const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
                  setSelectedSize(preset || null);
                }}
              >
                {SIZE_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.description})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || loading}>Save</Button>
        </div>
      </div>
    </div>
  );
}
