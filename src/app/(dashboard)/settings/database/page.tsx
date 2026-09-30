/**
 * Database settings page: health and backup.
 *
 * Backed by /api/db/health and the export/import dialogs.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DatabaseExportDialog } from '@/components/dialogs/DatabaseExportDialog';
import { DatabaseImportDialog } from '@/components/dialogs/DatabaseImportDialog';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface MigrationStatus {
  expected: string[];
  applied: string[];
  missing: string[];
  pending: string[];
  schemaVersion: string;
  upToDate: boolean;
}

interface DatabaseHealth {
  status: 'ok' | 'degraded' | 'error';
  ready: boolean;
  schemaVersion: string;
  nodeId: string | null;
  leader: string | null;
  raftIndex: number | null;
  migrations: MigrationStatus | null;
  tables: { expected: string[]; present: string[]; missing: string[] };
  counts: Record<string, number>;
  missingConfigKeys: string[];
  errors: string[];
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  degraded: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

export default function DatabaseSettingsPage() {
  const [health, setHealth] = useState<DatabaseHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const healthRes = await fetchWithAuth('/api/db/health');
      const healthJson = await healthRes.json();
      if (healthJson.error) throw new Error(healthJson.error.message);

      setHealth(healthJson.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load database status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const status = health?.status ?? 'error';

  return (
    <>
      <Header title="Database" />
      <div className="p-8 space-y-6 max-w-4xl">
        {error && (
          <div className="p-3 rounded bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Health</CardTitle>
            <span className={`px-3 py-1 text-sm rounded-full ${STATUS_STYLES[status]}`}>
              {status}
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading || !health ? (
              <p className="text-gray-500">Loading...</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">Ready</div>
                    <div>{health.ready ? 'Yes' : 'No'}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">Schema version</div>
                    <div>{health.schemaVersion}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">Node</div>
                    <div className="font-mono text-xs">{health.nodeId || '—'}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 dark:text-gray-400">Leader</div>
                    <div className="font-mono text-xs">{health.leader || '—'}</div>
                  </div>
                </div>

                <div>
                  <div className="text-sm font-medium mb-2">Migrations</div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Migration</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(health.migrations?.expected || []).map(id => {
                        const applied = health.migrations?.applied.includes(id);
                        return (
                          <TableRow key={id}>
                            <TableCell className="font-mono text-xs">{id}</TableCell>
                            <TableCell>
                              <span className={applied ? 'text-green-600' : 'text-red-600'}>
                                {applied ? 'Applied' : 'Missing'}
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {(health.migrations?.pending.length ?? 0) > 0 && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      Unknown migrations applied: {health.migrations?.pending.join(', ')}
                    </p>
                  )}
                </div>

                {health.tables.missing.length > 0 && (
                  <p className="text-sm text-red-600 dark:text-red-400">
                    Missing tables: {health.tables.missing.join(', ')}
                  </p>
                )}

                {health.missingConfigKeys.length > 0 && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    Missing config keys: {health.missingConfigKeys.join(', ')}
                  </p>
                )}

                <div>
                  <div className="text-sm font-medium mb-2">Row counts</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                    {Object.entries(health.counts).map(([table, count]) => (
                      <div key={table} className="flex justify-between">
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{table}</span>
                        <span>{count < 0 ? '—' : count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <Button variant="outline" size="sm" onClick={load}>
                  Refresh
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Backup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Export the database to a portable backup, or restore from a previous backup file.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowExport(true)}>Export</Button>
              <Button variant="outline" onClick={() => setShowImport(true)}>Import</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <DatabaseExportDialog open={showExport} onOpenChange={setShowExport} />
      <DatabaseImportDialog open={showImport} onOpenChange={setShowImport} onImported={load} />
    </>
  );
}
