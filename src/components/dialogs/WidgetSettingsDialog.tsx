'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';

interface WidgetSettingsDialogProps {
  widgetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSizeChange?: () => void;
}

export function WidgetSettingsDialog({ widgetId, open, onOpenChange, onSizeChange }: WidgetSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<any>(null);
  const [selectedSize, setSelectedSize] = useState<SizePreset | null>(null);
  
  useEffect(() => {
    if (open && widgetId) {
      setLoading(true);
      fetchWithAuth(`/api/widgets/${widgetId}/settings`)
        .then(r => r.json())
        .then(json => {
          if (json.data) {
            setData(json.data);
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
  
  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...data };
      if (selectedSize) {
        payload.grid_w = selectedSize.gridW;
        payload.grid_h = selectedSize.gridH;
      }
      await fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (onSizeChange) onSizeChange();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };
  
  if (!open) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-md mx-4">
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

            <div>
              <Label>Poll Interval (seconds)</Label>
              <Input
                type="number"
                value={data?.poll_interval_sec || ''}
                onChange={e => setData({ ...data, poll_interval_sec: parseInt(e.target.value) || null })}
                placeholder="30"
              />
            </div>
            
            <div>
              <Label>TTL (seconds)</Label>
              <Input
                type="number"
                value={data?.ttl_sec || ''}
                onChange={e => setData({ ...data, ttl_sec: parseInt(e.target.value) || null })}
                placeholder="300"
              />
            </div>
            
            <div>
              <Label>Storage Mode</Label>
              <select
                className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                value={data?.storage_mode || 'latest_ttl'}
                onChange={e => setData({ ...data, storage_mode: e.target.value })}
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