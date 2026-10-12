'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { LineChart, LineChartPoint } from '@/components/shared/LineChart';

interface WidgetHistoryDialogProps {
  widgetId: string;
  widgetTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HistorySample {
  collected_at: string;
  data: Record<string, unknown>;
}

/** Numeric top-level fields of an arbitrary sample payload, for the chart picker. */
function numericFields(sample: Record<string, unknown> | undefined): string[] {
  if (!sample) return [];
  return Object.entries(sample)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
    .sort();
}

export function WidgetHistoryDialog({ widgetId, widgetTitle, open, onOpenChange }: WidgetHistoryDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<HistorySample[]>([]);
  const [selectedField, setSelectedField] = useState<string>('');

  useEffect(() => {
    if (!open || !widgetId) return;
    setLoading(true);
    setError(null);
    fetchWithAuth(`/api/widgets/${widgetId}/history`)
      .then(r => readJson<{ data?: { samples?: HistorySample[] }; error?: { message: string } }>(r))
      .then(json => {
        if (json.error) {
          setError(json.error.message);
          setSamples([]);
          return;
        }
        setSamples(json.data?.samples || []);
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [open, widgetId]);

  const fields = useMemo(() => numericFields(samples[samples.length - 1]?.data), [samples]);

  useEffect(() => {
    if (fields.length && !fields.includes(selectedField)) setSelectedField(fields[0]);
    if (!fields.length) setSelectedField('');
  }, [fields, selectedField]);

  const points = useMemo<LineChartPoint[]>(() => {
    if (!selectedField) return [];
    return samples
      .map(s => {
        const v = s.data[selectedField];
        const t = new Date(s.collected_at).getTime();
        return typeof v === 'number' && Number.isFinite(v) && Number.isFinite(t) ? { x: t, y: v } : null;
      })
      .filter((p): p is LineChartPoint => p !== null);
  }, [samples, selectedField]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-3xl mx-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-1">History: {widgetTitle}</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Samples recorded at the widget&apos;s poll interval, retained for its TTL.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : samples.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No history yet — set a TTL on this widget to start recording.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Field</Label>
              <select
                className="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600"
                value={selectedField}
                onChange={e => setSelectedField(e.target.value)}
                disabled={fields.length === 0}
              >
                {fields.length === 0 ? (
                  <option value="">No numeric fields in samples</option>
                ) : (
                  fields.map(f => <option key={f} value={f}>{f}</option>)
                )}
              </select>
            </div>

            <LineChart points={points} />

            <div>
              <Label>Raw samples ({samples.length})</Label>
              <div className="mt-2 max-h-64 overflow-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Time</th>
                      <th className="text-left px-2 py-1 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...samples].reverse().map((s, i) => (
                      <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                        <td className="px-2 py-1 whitespace-nowrap align-top">{new Date(s.collected_at).toLocaleString()}</td>
                        <td className="px-2 py-1 font-mono break-all">{JSON.stringify(s.data)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </div>
    </div>
  );
}
