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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
    <Dialog open={open} onOpenChange={o => { if (!o) onOpenChange(false); }}>
      <DialogContent size="lg" className="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Export Database</DialogTitle>
        </DialogHeader>

        {error && <div className="mb-4 text-sm text-destructive">{error}</div>}

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
                    <span className="block text-muted-foreground">{f.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {isJson && (
            <>
              <div>
                <Label className="mb-2">Tables</Label>
                <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto xs:grid-cols-2">
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
                <p className="text-xs text-warning">
                  Secrets are exported encrypted with this host&apos;s MASTER_KEY. They can only
                  be restored on a host using the same MASTER_KEY. Plaintext is never exported.
                </p>
              )}
            </>
          )}

          <p className="text-xs text-muted-foreground">
            Format version {options?.formatVersion ?? '—'} · schema version {options?.schemaVersion ?? '—'}
          </p>
        </div>

        <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={busy || (isJson && tables.length === 0)}>
            {busy ? 'Exporting...' : 'Export'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
