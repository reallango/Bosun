'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface WidgetSettingsDialogProps {
  widgetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WidgetSettingsDialog({ widgetId, open, onOpenChange }: WidgetSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<any>(null);
  
  useEffect(() => {
    if (open && widgetId) {
      setLoading(true);
      fetchWithAuth(`/api/widgets/${widgetId}/settings`)
        .then(r => r.json())
        .then(json => {
          if (json.data) setData(json.data);
        })
        .finally(() => setLoading(false));
    }
  }, [open, widgetId]);
  
  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
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
                className="w-full border rounded px-3 py-2"
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