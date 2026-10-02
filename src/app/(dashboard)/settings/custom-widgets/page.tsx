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
  const [collectorTypes, setCollectorTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/api/custom-widgets');
      const json = await res.json();
      setWidgets(ensureArray<CustomWidget>(json?.data?.widgets));
      setCollectorTypes(ensureArray<string>(json?.data?.collectorTypes));
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
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Custom Widgets</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Database-defined widget types. Toggle platform support and database caching per type.
          </p>
        </div>
        <button
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          onClick={() => setShowForm(v => !v)}
        >
          {showForm ? 'Cancel' : 'Register custom widget'}
        </button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {showForm && (
        <RegisterForm
          collectorTypes={collectorTypes}
          registeredTypes={widgets.map(w => w.type)}
          onCreated={() => { setShowForm(false); load(); }}
          onError={setError}
        />
      )}

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

interface RegisterFormProps {
  /** Types that have a collector implementation and may be registered. */
  collectorTypes: string[];
  /** Types already registered, so a duplicate is obvious before submitting. */
  registeredTypes: string[];
  onCreated: () => void;
  onError: (msg: string | null) => void;
}

/**
 * Register a new custom widget type.
 *
 * Registration is limited to types with a collector implementation (listed in
 * `collectorTypes`), because a type without a collector would be added, polled
 * forever and never produce data. Everything else about the type (sizing,
 * caching, platform support) is set here and can be retuned later with the
 * toggles above.
 */
function RegisterForm({ collectorTypes, registeredTypes, onCreated, onError }: RegisterFormProps) {
  const available = collectorTypes.filter(t => !registeredTypes.includes(t));
  const [form, setForm] = useState({
    type: '',
    display_name: '',
    description: '',
    icon: 'puzzle',
    category: 'custom',
    use_database: true,
    supports_linux: true,
    supports_windows: false,
    default_poll_interval: 30,
    default_ttl: 1800,
    storage_mode: 'latest_ttl',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    onError(null);
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/widget-definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (json?.error) { onError(json.error.message); return; }
      onCreated();
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border">
      <div className="font-medium mb-3">Register custom widget</div>

      {available.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          All collector-backed widget types are already registered.
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Type</label>
            <select
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={form.type}
              onChange={e => set('type', e.target.value)}
            >
              <option value="">Select a type…</option>
              {available.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Only types with a collector implementation can be registered.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Display name</label>
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.display_name}
                onChange={e => set('display_name', e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Icon</label>
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.icon}
                onChange={e => set('icon', e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Description</label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={form.description}
              onChange={e => set('description', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.supports_linux} onChange={e => set('supports_linux', e.target.checked)} />
              Linux
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.supports_windows} onChange={e => set('supports_windows', e.target.checked)} />
              Windows
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.use_database} onChange={e => set('use_database', e.target.checked)} />
              Use database
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-sm font-medium">Poll interval (s)</label>
              <input
                type="number"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.default_poll_interval}
                onChange={e => set('default_poll_interval', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="text-sm font-medium">TTL (s)</label>
              <input
                type="number"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.default_ttl}
                onChange={e => set('default_ttl', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Storage mode</label>
              <select
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={form.storage_mode}
                onChange={e => set('storage_mode', e.target.value)}
              >
                <option value="latest_ttl">latest_ttl</option>
                <option value="change_only">change_only</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              disabled={saving || !form.type || !form.display_name}
              onClick={submit}
            >
              {saving ? 'Registering…' : 'Register'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
