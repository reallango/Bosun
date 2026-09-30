/**
 * Modal for configuring and downloading a database export.
 *
 * Loads the available formats and tables from /api/db/export/options, then
 * streams the selected backup from /api/db/export as a file download. Secrets
 * are opt-in; when enabled only the encrypted ciphertext is included.
 */
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface ExportOptions {
  formats: { id: string; label: string; description: string }[];
  tables: string[];
  largeTables: string[];
  formatVersion: number;
  schemaVersion: string;
}

interface DatabaseExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DatabaseExportDialog({ open, onOpenChange }: DatabaseExportDialogProps) {
  const [options, setOptions] = useState<ExportOptions | null>(null);
  const [format, setFormat] = useState('json');
  const [tables, setTables] = useState<string[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [excludeLarge, setExcludeLarge] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    (async () => {
      try {
        const res = await fetchWithAuth('/api/db/export/options');
        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        setOptions(json.data);
        setTables(json.data.tables);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load export options');
      }
    })();
  }, [open]);

  if (!open) return null;

  const isJson = format === 'json';

  const toggleTable = (table: string) => {
    setTables(prev =>
      prev.includes(table) ? prev.filter(t => t !== table) : [...prev, table],
    );
  };

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ format });
      if (isJson) {
        params.set('tables', tables.join(','));
        params.set('includeSecrets', String(includeSecrets));
        params.set('excludeLarge', String(excludeLarge));
      }
      const res = await fetchWithAuth(`/api/db/export?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || 'bosun-backup';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4">Export Database</h2>

        {error && <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>}

        <div className="space-y-4">
          <div>
            <Label className="mb-2">Format</Label>
            <div className="space-y-2">
              {(options?.formats || []).map(f => (
                <label key={f.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="format"
                    value={f.id}
                    checked={format === f.id}
                    onChange={() => setFormat(f.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{f.label}</span>
                    <span className="block text-gray-500 dark:text-gray-400">{f.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {isJson && (
            <>
              <div>
                <Label className="mb-2">Tables</Label>
                <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
                  {(options?.tables || []).map(t => (
                    <label key={t} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={tables.includes(t)}
                        onChange={() => toggleTable(t)}
                      />
                      <span className="font-mono text-xs">{t}</span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={excludeLarge}
                  onChange={e => setExcludeLarge(e.target.checked)}
                />
                Exclude large tables ({options?.largeTables.join(', ')})
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeSecrets}
                  onChange={e => setIncludeSecrets(e.target.checked)}
                />
                Include encrypted secrets (SSH keys, password hashes)
              </label>

              {includeSecrets && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Secrets are exported encrypted with this host&apos;s MASTER_KEY. They can only
                  be restored on a host using the same MASTER_KEY. Plaintext is never exported.
                </p>
              )}
            </>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Format version {options?.formatVersion ?? '—'} · schema version {options?.schemaVersion ?? '—'}
          </p>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={busy || (isJson && tables.length === 0)}>
            {busy ? 'Exporting...' : 'Export'}
          </Button>
        </div>
      </div>
    </div>
  );
}
