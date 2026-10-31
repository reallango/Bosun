'use client';

import { useCallback, useEffect, useState } from 'react';
import { Puzzle, Trash2 } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface CustomWidgetRow {
  id: string;
  type: string;
  display_name: string;
  description: string;
  default_size: string;
  refresh_interval: number;
  supports_linux: number;
  supports_windows: number;
  enabled: number;
  builtin: number;
}

type ApiResult<T> = { data?: T; error?: { message?: string } };

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetchWithAuth(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await readJson<ApiResult<T>>(res);
  if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.data as T;
}

function sizeOf(raw: string): { w: number; h: number } {
  try { return JSON.parse(raw); } catch { return { w: 8, h: 6 }; }
}

/**
 * Widget types defined in the database (Settings → Custom Widgets). Admins can
 * rename them, change their default size and refresh interval, restrict them
 * to Linux or Windows, or disable them, without a rebuild. New widgets are added as packages (Settings, Widgets).
 */
export default function CustomWidgetsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState<CustomWidgetRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await api<{ widgets: CustomWidgetRow[] }>('/api/custom-widgets');
      setRows(d.widgets || []);
    } catch (err) {
      toast('Failed to load custom widgets', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const patch = async (type: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/widget-definitions/${encodeURIComponent(type)}`, 'PATCH', body);
      await load();
    } catch (err) {
      toast('Update failed', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  };

  const remove = async (type: string) => {
    try {
      await api(`/api/widget-definitions/${encodeURIComponent(type)}`, 'DELETE');
      await load();
    } catch (err) {
      toast('Delete failed', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <>
      <Header title="Custom Widgets" />
      <div className="page max-w-5xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Widget types stored in the database. Changes apply to the Add Widget picker immediately; built-in types can be
          disabled but not deleted.
        </p>

        {loading ? <LoadingSpinner /> : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">No custom widgets</div>
        ) : (
          <ul className="space-y-3">
            {rows.map(w => {
              const size = sizeOf(w.default_size);
              return (
                <li key={w.id} className="rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <Puzzle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{w.display_name}</span>
                        <code className="rounded bg-muted px-1 text-xs">{w.type}</code>
                        {w.builtin === 1 && <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">built-in</span>}
                        {w.enabled !== 1 && <span className="rounded bg-yellow-500/15 px-1 text-[10px] uppercase text-yellow-700 dark:text-yellow-400">disabled</span>}
                      </div>
                      {w.description && <p className="mt-0.5 text-sm text-muted-foreground">{w.description}</p>}
                    </div>
                    {isAdmin && w.builtin !== 1 && (
                      <Button variant="ghost" size="icon-sm" onClick={() => remove(w.type)} aria-label={`Delete ${w.display_name}`}>
                        <Trash2 className="text-destructive" />
                      </Button>
                    )}
                  </div>
                  <fieldset disabled={!isAdmin} className="mt-3 grid grid-cols-1 gap-3 text-sm xs:grid-cols-2 lg:grid-cols-5">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={w.enabled === 1} onChange={e => patch(w.type, { enabled: e.target.checked })} /> Enabled
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={w.supports_linux === 1} onChange={e => patch(w.type, { supports_linux: e.target.checked })} /> Linux
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={w.supports_windows === 1} onChange={e => patch(w.type, { supports_windows: e.target.checked })} /> Windows
                    </label>
                    <label className="flex items-center gap-2">
                      Size
                      <Input type="number" min={1} max={48} defaultValue={size.w} className="h-7 w-14" aria-label="Default width"
                        onBlur={e => Number(e.target.value) !== size.w && patch(w.type, { default_size: { ...size, w: Number(e.target.value) } })} />
                      ×
                      <Input type="number" min={1} max={48} defaultValue={size.h} className="h-7 w-14" aria-label="Default height"
                        onBlur={e => Number(e.target.value) !== size.h && patch(w.type, { default_size: { ...size, h: Number(e.target.value) } })} />
                    </label>
                    <label className="flex items-center gap-2">
                      Refresh
                      <Input type="number" min={5} max={3600} defaultValue={w.refresh_interval} className="h-7 w-16" aria-label="Refresh interval (s)"
                        onBlur={e => Number(e.target.value) !== w.refresh_interval && patch(w.type, { refresh_interval: Number(e.target.value) })} />
                      s
                    </label>
                  </fieldset>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
