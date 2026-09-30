'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface ImportResult {
  format: string;
  schemaVersion: string | null;
  counts: Record<string, number>;
  warnings: string[];
}

interface DatabaseImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}

export function DatabaseImportDialog({ open, onOpenChange, onImported }: DatabaseImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  if (!open) return null;

  const reset = () => {
    setFile(null);
    setReplace(false);
    setError(null);
    setResult(null);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handleImport = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('replace', String(replace));

      const res = await fetchWithAuth('/api/db/import', { method: 'POST', body: formData });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      setResult(json.data as ImportResult);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={close} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-4">Import Database</h2>

        {error && <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>}

        {result ? (
          <div className="space-y-3">
            <p className="text-sm">
              Imported <strong>{result.format}</strong> backup
              {result.schemaVersion ? ` (schema ${result.schemaVersion})` : ''}.
            </p>
            {Object.keys(result.counts).length > 0 && (
              <div className="text-sm">
                <p className="font-medium mb-1">Rows imported</p>
                <ul className="list-disc list-inside text-gray-600 dark:text-gray-400">
                  {Object.entries(result.counts).map(([table, count]) => (
                    <li key={table}>
                      <span className="font-mono text-xs">{table}</span>: {count}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.warnings.length > 0 && (
              <div className="text-sm text-amber-600 dark:text-amber-400">
                <p className="font-medium mb-1">Warnings</p>
                <ul className="list-disc list-inside">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="mb-2">Backup file</Label>
              <Input
                type="file"
                accept=".json,.sqlite,.sqlite3,.sql,application/json,application/octet-stream,text/plain"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Format is detected automatically (JSON, SQLite snapshot, or SQL dump).
              </p>
            </div>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={replace}
                onChange={e => setReplace(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Replace existing data</span>
                <span className="block text-gray-500 dark:text-gray-400">
                  Clears each table before importing. Required for SQLite/SQL restores.
                </span>
              </span>
            </label>

            {replace && (
              <p className="text-xs text-red-600 dark:text-red-400">
                This permanently deletes existing rows in the imported tables and cannot be undone.
              </p>
            )}
          </div>
        )}

        {!result && (
          <div className="flex justify-end gap-2 mt-6">
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={replace ? 'destructive' : 'default'}
              onClick={handleImport}
              disabled={busy || !file}
            >
              {busy ? 'Importing...' : replace ? 'Replace & Import' : 'Import'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
