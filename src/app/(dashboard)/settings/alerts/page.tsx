'use client';

import { useState, useEffect, useCallback } from 'react';
import { BellRing, Plus, Trash2 } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { cn } from '@/lib/utils';

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  cooldown_seconds: number;
  enabled: boolean;
}

const CONDITION_LABEL: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' };

const EMPTY_FORM = { name: '', metric: 'cpu', condition: 'gt', threshold: 80, cooldown_seconds: 300, channel_ids: [] as string[], enabled: true };

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      const rulesRes = await fetchWithAuth('/api/alert-rules');
      const rulesJson = await rulesRes.json();
      setRules(rulesJson?.data?.rules || []);
    } catch (err) {
      toast('Failed to load alert rules', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      setShowForm(false);
      setForm(EMPTY_FORM);
      fetchData();
    } catch (err) {
      toast('Failed to save rule', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    await fetchWithAuth(`/api/alert-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    fetchData();
  };

  const deleteRule = async (id: string) => {
    await fetchWithAuth(`/api/alert-rules/${id}`, { method: 'DELETE' });
    fetchData();
  };

  return (
    <>
      <Header title="Alert Rules" />
      <div className="page max-w-5xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Notify when a metric crosses a threshold.</p>
          {!showForm && (
            <Button size="lg" onClick={() => setShowForm(true)}>
              <Plus />
              Add alert rule
            </Button>
          )}
        </div>

        {showForm && (
          <Card>
            <CardHeader>
              <CardTitle>New alert rule</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="alert-name">Name</Label>
                  <Input id="alert-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-metric">Metric</Label>
                  <select id="alert-metric" value={form.metric} onChange={e => setForm({ ...form, metric: e.target.value })} className="form-select">
                    <option value="cpu">CPU Usage</option>
                    <option value="memory">Memory Usage</option>
                    <option value="disk">Disk Usage</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-condition">Condition</Label>
                  <select id="alert-condition" value={form.condition} onChange={e => setForm({ ...form, condition: e.target.value })} className="form-select">
                    <option value="gt">&gt; Greater than</option>
                    <option value="lt">&lt; Less than</option>
                    <option value="gte">≥ Greater or equal</option>
                    <option value="lte">≤ Less or equal</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-threshold">Threshold</Label>
                  <Input id="alert-threshold" type="number" inputMode="decimal" value={form.threshold} onChange={e => setForm({ ...form, threshold: Number(e.target.value) })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-cooldown">Cooldown (seconds)</Label>
                  <Input id="alert-cooldown" type="number" inputMode="numeric" value={form.cooldown_seconds} onChange={e => setForm({ ...form, cooldown_seconds: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end lg:col-span-3">
                  <Button type="button" variant="outline" size="lg" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="lg" disabled={saving}>
                    {saving ? 'Saving…' : 'Save rule'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <LoadingSpinner />
        ) : rules.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">No alert rules configured</div>
        ) : (
          <ul className="space-y-2">
            {rules.map(rule => (
              <li key={rule.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <BellRing className={cn('mt-0.5 size-4 shrink-0', rule.enabled ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{rule.name}</div>
                    <div className="text-sm text-muted-foreground">
                      When {rule.metric} {CONDITION_LABEL[rule.condition] ?? rule.condition} {rule.threshold} · cooldown {rule.cooldown_seconds}s
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                    onClick={() => toggleRule(rule.id, !rule.enabled)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      rule.enabled ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {rule.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <Button variant="ghost" size="icon-lg" onClick={() => deleteRule(rule.id)} aria-label={`Delete ${rule.name}`}>
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
