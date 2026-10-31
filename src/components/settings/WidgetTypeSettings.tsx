'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

/** The row of a widget type as `/api/custom-widgets` returns it. */
export interface WidgetTypeRow {
  type: string;
  display_name: string;
  default_size: string;
  min_size: string;
  refresh_interval: number;
  supports_linux: number;
  supports_windows: number;
  enabled: number;
}

const sizeOf = (raw: string, fallback: { w: number; h: number }): { w: number; h: number } => {
  try {
    const v = JSON.parse(raw);
    return Number(v?.w) > 0 && Number(v?.h) > 0 ? { w: Number(v.w), h: Number(v.h) } : fallback;
  } catch { return fallback; }
};

/**
 * Settings of one installed widget type (opened with the cog on Settings → Widgets): whether it is offered, the platforms it
 * supports, its default and minimum size and its refresh interval. Changes apply to the Add Widget picker at once.
 */
export default function WidgetTypeSettings({ row, onChanged }: { row: WidgetTypeRow; onChanged: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const def = sizeOf(row.default_size, { w: 8, h: 6 });
  const min = sizeOf(row.min_size, { w: 4, h: 4 });

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetchWithAuth(`/api/widget-definitions/${encodeURIComponent(row.type)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await readJson<{ error?: { message?: string } }>(res);
      if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
      await onChanged();
    } catch (err) {
      toast('Update failed', { variant: 'error', description: err instanceof Error ? err.message : undefined });
      await onChanged();   // put the fields back to what is stored
    } finally {
      setBusy(false);
    }
  };

  const number = (label: string, value: number, min_: number, max: number, onCommit: (n: number) => void, key: string) => (
    <Input key={`${key}-${value}`} type="number" min={min_} max={max} defaultValue={value} className="h-8 w-16 shrink-0" aria-label={label} disabled={busy}
      onBlur={e => { const n = Math.round(Number(e.target.value)); if (n !== value && n >= min_ && n <= max) onCommit(n); }} />
  );

  return (
    <fieldset className="mt-2 grid grid-cols-1 gap-3 rounded-lg bg-muted/50 p-3 text-sm" disabled={busy}>
      <legend className="sr-only">Settings of {row.display_name}</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ">
        <label className="flex items-center gap-2"><input type="checkbox" checked={row.enabled === 1} onChange={e => patch({ enabled: e.target.checked })} /> Offered when adding widgets</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={row.supports_linux === 1} onChange={e => patch({ supports_linux: e.target.checked })} /> Linux</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={row.supports_windows === 1} onChange={e => patch({ supports_windows: e.target.checked })} /> Windows</label>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-muted-foreground">Default size</span>
        {number('Default width', def.w, 1, 48, w => patch({ default_size: { ...def, w } }), 'dw')}
        <span aria-hidden>×</span>
        {number('Default height', def.h, 1, 48, h => patch({ default_size: { ...def, h } }), 'dh')}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-muted-foreground">Smallest size</span>
        {number('Minimum width', min.w, 1, 48, w => patch({ min_size: { ...min, w } }), 'mw')}
        <span aria-hidden>×</span>
        {number('Minimum height', min.h, 1, 48, h => patch({ min_size: { ...min, h } }), 'mh')}
      </div>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-muted-foreground">Refresh</span>
        {number('Refresh interval (seconds)', row.refresh_interval, 5, 3600, n => patch({ refresh_interval: n }), 'ri')}
        <span className="text-muted-foreground">seconds</span>
      </div>
      <p className="text-xs text-muted-foreground ">
        Sizes are grid columns × rows. The default size is what a new widget starts with and can never be smaller than the smallest size.
      </p>
    </fieldset>
  );
}
