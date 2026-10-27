'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { SIZE_PRESETS, SizePreset } from '@/lib/widget-sizes';

interface WidgetSettingsDialogProps {
  widgetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: () => void;
}

export function WidgetSettingsDialog({ widgetId, open, onOpenChange, onSave }: WidgetSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [selectedSize, setSelectedSize] = useState<SizePreset | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open && widgetId) {
      setLoading(true);
      setError(null);
      fetchWithAuth(`/api/widgets/${widgetId}/settings`)
        .then(r => r.json())
        .then(json => {
          if (json.data) {
            setData(json.data);
            // Find matching size preset or set to null
            const matchingPreset = SIZE_PRESETS.find(p => p.gridW === json.data.grid_w && p.gridH === json.data.grid_h);
            setSelectedSize(matchingPreset || null);
          } else if (json.error) {
            setError(json.error.message || 'Failed to load settings');
          }
        })
        .catch(() => setError('Failed to load settings'))
        .finally(() => setLoading(false));
    }
  }, [open, widgetId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...data };
      // Always include grid_w and grid_h - use selectedSize if available, otherwise use current values from data
      if (selectedSize) {
        payload.grid_w = selectedSize.gridW;
        payload.grid_h = selectedSize.gridH;
      } else if (data?.grid_w !== undefined) {
        payload.grid_w = data.grid_w;
        payload.grid_h = data.grid_h;
      }
      const res = await fetchWithAuth(`/api/widgets/${widgetId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      toast('Widget settings saved', { variant: 'success' });
      onSave?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Widget settings</DialogTitle>
          <DialogDescription>Name, polling and default (desktop) size.</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-4">
              {error && (
                <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`ws-name-${widgetId}`}>Display name</Label>
                <Input
                  id={`ws-name-${widgetId}`}
                  value={data?.display_name || ''}
                  onChange={e => setData({ ...data, display_name: e.target.value })}
                  placeholder="Optional custom name"
                />
              </div>

              <div className="grid gap-4 xs:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`ws-poll-${widgetId}`}>Poll interval (s)</Label>
                  <Input
                    id={`ws-poll-${widgetId}`}
                    type="number"
                    inputMode="numeric"
                    value={data?.poll_interval_sec || ''}
                    onChange={e => setData({ ...data, poll_interval_sec: parseInt(e.target.value) || null })}
                    placeholder="30"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`ws-ttl-${widgetId}`}>TTL (s)</Label>
                  <Input
                    id={`ws-ttl-${widgetId}`}
                    type="number"
                    inputMode="numeric"
                    value={data?.ttl_sec || ''}
                    onChange={e => setData({ ...data, ttl_sec: parseInt(e.target.value) || null })}
                    placeholder="300"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`ws-storage-${widgetId}`}>Storage mode</Label>
                <select
                  id={`ws-storage-${widgetId}`}
                  className="form-select"
                  value={data?.storage_mode || 'latest_ttl'}
                  onChange={e => setData({ ...data, storage_mode: e.target.value })}
                >
                  <option value="latest_ttl">Latest TTL</option>
                  <option value="change_only">Change Only</option>
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={data?.enabled !== 0}
                  onChange={e => setData({ ...data, enabled: e.target.checked ? 1 : 0 })}
                />
                Enable polling
              </label>

              <div className="space-y-1.5">
                <Label htmlFor={`ws-size-${widgetId}`}>Size</Label>
                <select
                  id={`ws-size-${widgetId}`}
                  className="form-select"
                  value={selectedSize?.id || 'custom'}
                  onChange={e => {
                    const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
                    setSelectedSize(preset || null);
                  }}
                >
                  {!selectedSize && <option value="custom">Custom ({data?.grid_w}x{data?.grid_h})</option>}
                  {SIZE_PRESETS.map(preset => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.description})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">Applies to the desktop (24-column) layout; other screen sizes adapt automatically.</p>
              </div>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
