'use client';

import { useState, useEffect } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ensureArray } from '@/lib/api/ensureArray';

/**
 * Custom widget types.
 *
 * A custom widget lives in the `custom_widgets` table rather than the compiled
 * registry, so its platform support and caching behaviour are configurable here
 * without a rebuild. Each toggle PATCHes the type and takes effect on the next
 * dashboard load / poller cycle.
 */
interface CustomWidget {
  id: string;
  type: string;
  display_name: string;
  description: string | null;
  category: string | null;
  use_database: number;
  supports_linux: number;
  supports_windows: number;
  default_poll_interval: number | null;
  default_ttl: number | null;
  storage_mode: string | null;
  enabled: number;
  builtin: number;
}

export default function CustomWidgetsPage() {
  const [widgets, setWidgets] = useState<CustomWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/custom-widgets');
      const json = await res.json();
      setWidgets(ensureArray<CustomWidget>(json?.data?.widgets));
      setError(null);
    } catch {
      setError('Failed to load custom widgets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const patch = async (type: string, body: Record<string, unknown>) => {
    const res = await fetchWithAuth(`/api/widget-definitions/${type}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json?.error) setError(json.error.message);
    else load();
  };

  if (loading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Custom Widgets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Database-defined widget types. Toggle platform support and database caching per type.
        </p>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {widgets.length === 0 ? (
        <div className="text-gray-500 text-center py-8">No custom widgets registered</div>
      ) : (
        <div className="space-y-3">
          {widgets.map(w => (
            <div key={w.type} className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium flex items-center gap-2">
                    {w.display_name}
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200">
                      Custom
                    </span>
                    {!w.enabled && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 font-mono">{w.type}</div>
                  {w.description && <div className="text-sm text-gray-500 mt-1">{w.description}</div>}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!w.supports_linux}
                    onChange={e => patch(w.type, { supports_linux: e.target.checked })}
                  />
                  Linux
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!w.supports_windows}
                    onChange={e => patch(w.type, { supports_windows: e.target.checked })}
                  />
                  Windows
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!w.use_database}
                    onChange={e => patch(w.type, { use_database: e.target.checked })}
                  />
                  Use database
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!w.enabled}
                    onChange={e => patch(w.type, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
              </div>

              <div className="mt-2 text-xs text-muted-foreground">
                Poll every {w.default_poll_interval ?? 30}s · TTL {w.default_ttl ?? 1800}s · {w.storage_mode || 'latest_ttl'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
