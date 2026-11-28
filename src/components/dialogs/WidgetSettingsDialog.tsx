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
import { readJson } from '@/lib/api/readJson';
import { WidgetConfigField } from '@/types/widget';
import { useAuth } from '@/hooks/useAuth';


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
  const [sizeTouched, setSizeTouched] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [configSchema, setConfigSchema] = useState<WidgetConfigField[]>([]);
  const setConfigValue = (key: string, value: unknown) => setConfig(prev => ({ ...prev, [key]: value }));
  const { toast } = useToast();
  const { can } = useAuth();
  // A setting the package guards with a permission is read-only for people who lack it.
  const locked = (f: WidgetConfigField) => !!f.requires_permission && !can(f.requires_permission, data?.server_id);
  // The "Look" field Bosun adds carries each look's own floor and suggested size.
  const lookField = configSchema.find(f => f.lookSizes);
  const lookSize = (id: unknown) => lookField?.lookSizes?.[String(id ?? '')];
  const changeConfig = (field: WidgetConfigField, value: unknown) => {
    setConfigValue(field.key, value);
    const suggested = field.lookSizes ? field.lookSizes[String(value)]?.default : undefined;
    if (!suggested || sizeTouched) return;
    const preset = SIZE_PRESETS.find(p => p.gridW === suggested.w && p.gridH === suggested.h);
    setSelectedSize(preset ?? { id: `look-${String(value)}`, name: 'Look size', gridW: suggested.w, gridH: suggested.h, description: `${suggested.w}x${suggested.h}` });
  };

  useEffect(() => {
    if (open && widgetId) {
      setLoading(true);
      setError(null);
      setSizeTouched(false);
      fetchWithAuth(`/api/widgets/${widgetId}/settings`)
        .then(r => readJson<{ data?: any; error?: { message?: string } }>(r)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .then(json => {
          if (json.data) {
            setData(json.data);
            setConfig(json.data.config && typeof json.data.config === 'object' ? json.data.config : {});
            setConfigSchema(Array.isArray(json.data.config_schema) ? json.data.config_schema : []);
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
      // Only widget-level fields; polling is configured per server.
      const payload: Record<string, unknown> = { display_name: data?.display_name ?? null };
      // Guarded settings the person may not change are not sent back.
      const editable = configSchema.filter(f => !locked(f));
      if (editable.length) payload.config = Object.fromEntries(editable.map(f => [f.key, config[f.key] ?? f.default ?? null]));
      // Always include grid_w and grid_h - use selectedSize if available, otherwise use current values from data.
      // A look's own floor is never smaller than the size the person picked, so raise the size to it.
      const min = lookSize(config[lookField?.key ?? ''] ?? lookField?.default);
      if (selectedSize) {
        payload.grid_w = Math.max(selectedSize.gridW, min?.min?.w ?? 1);
        payload.grid_h = Math.max(selectedSize.gridH, min?.min?.h ?? 1);
      } else if (data?.grid_w !== undefined) {
        payload.grid_w = Math.max(Number(data.grid_w) || 4, min?.min?.w ?? 1);
        payload.grid_h = Math.max(Number(data.grid_h) || 3, min?.min?.h ?? 1);
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
          <DialogDescription>Name, widget options and default (desktop) size.</DialogDescription>
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

              {/* Widget-specific settings declared by the widget definition. */}
              {configSchema.map(field => {
                const id = `ws-cfg-${widgetId}-${field.key}`;
                const value = config[field.key] ?? field.default ?? '';
                return (
                  <div key={field.key} className="space-y-1.5">
                    {field.type === 'boolean' ? (
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input type="checkbox" className="size-4 accent-primary" checked={value === true || value === 'true'}
                          onChange={e => changeConfig(field, e.target.checked)} />
                        {field.label}
                      </label>
                    ) : (
                      <>
                        <Label htmlFor={id}>{field.label}</Label>
                        {field.type === 'select' ? (
                          <select id={id} className="form-select" value={String(value)} onChange={e => changeConfig(field, e.target.value)}>
                            {(field.options || []).map(o => <option key={o} value={o}>{field.optionLabels?.[o] ?? o}</option>)}
                          </select>
                        ) : (
                          <Input id={id} type={field.type === 'number' ? 'number' : 'text'} value={String(value)} placeholder={field.placeholder}
                            className={field.requires_permission ? 'font-mono' : undefined}
                            readOnly={locked(field)}
                            disabled={locked(field)}
                            onChange={e => changeConfig(field, field.type === 'number' ? Number(e.target.value) : e.target.value)} />
                        )}
                      </>
                    )}
                    {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                    {locked(field) && (
                      <p className="text-xs text-muted-foreground">You do not have the permission to change this setting.</p>
                    )}
                  </div>
                );
              })}

              <p className="text-xs text-muted-foreground">
                Data is collected once per server; the poll interval is set under Settings → Servers.
              </p>


              <div className="space-y-1.5">
                <Label htmlFor={`ws-size-${widgetId}`}>Size</Label>
                <select
                  id={`ws-size-${widgetId}`}
                  className="form-select"
                  value={selectedSize?.id || 'custom'}
                  onChange={e => {
                    const preset = SIZE_PRESETS.find(p => p.id === e.target.value);
                    setSizeTouched(true);
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
