'use client';

import { useState, useEffect, useCallback } from 'react';
import { BellRing, Mail, Plus, Trash2 } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { cn } from '@/lib/utils';
import { parseRecipients } from '@/lib/collect/recipients';

/** Validate a comma-separated recipient list; returns an error message or null. */
function recipientsError(value: string): string | null {
  const { invalid } = parseRecipients(value);
  return invalid.length ? `Invalid address: ${invalid.join(', ')}` : null;
}

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  server_id?: string | null;
  server_name?: string | null;
  severity?: string;
  trigger_count?: number;
  last_triggered?: string | null;
  cooldown_seconds: number;
  enabled: boolean;
  emails?: string[];
}

const CONDITION_LABEL: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' };

const EMPTY_FORM = { name: '', metric: 'cpu.usage', server_id: '', severity: 'warning', condition: 'gt', threshold: 90, cooldown_seconds: 900, channel_ids: [] as string[], emails: '', enabled: true };

// Metric keys recorded by the poller (see Statistics).
const METRICS: [string, string][] = [
  ['cpu.usage', 'CPU usage (%)'], ['mem.used_pct', 'Memory used (%)'], ['disk.max_used_pct', 'Fullest disk (%)'],
  ['disk.root_used_pct', 'Root disk (%)'], ['cpu.temp', 'CPU temperature (°C)'], ['cpu.load1', 'Load (1m)'],
  ['swap.used_mb', 'Swap used (MB)'], ['net.rx_bps', 'Network in (B/s)'], ['net.tx_bps', 'Network out (B/s)'],
  ['gpu0.util', 'GPU 0 utilization (%)'], ['gpu0.temp', 'GPU 0 temperature (°C)'], ['gpu0.vram_mb', 'GPU 0 VRAM used (MB)'],
  ['docker.running', 'Running containers'],
];
const METRIC_LABEL = Object.fromEntries(METRICS);

interface ServerOption { id: string; name: string }

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [editing, setEditing] = useState<{ id: string; emails: string } | null>(null);
  // Metrics recorded for the chosen server beyond the built-in list (for example by a widget package).
  const [serverMetrics, setServerMetrics] = useState<[string, string][]>([]);
  const { toast } = useToast();
  const formEmailError = form.emails.trim() ? recipientsError(form.emails) : null;

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

  useEffect(() => {
    fetchWithAuth('/api/servers')
      .then(r => r.json())
      .then(j => setServers((j?.data?.servers || []).map((s: ServerOption) => ({ id: s.id, name: s.name }))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!form.server_id) { setServerMetrics([]); return; }
    let live = true;
    fetchWithAuth(`/api/metrics?serverId=${encodeURIComponent(form.server_id)}`)
      .then(r => r.json())
      .then(j => { if (live) setServerMetrics(((j?.data?.metrics || []) as { metric: string; label?: string }[]).filter(m => !METRIC_LABEL[m.metric] && !/^gpu\d+\./.test(m.metric)).map(m => [m.metric, m.label || m.metric] as [string, string])); })
      .catch(() => { if (live) setServerMetrics([]); });
    return () => { live = false; };
  }, [form.server_id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formEmailError) return;
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, server_id: form.server_id || null, cooldown_sec: form.cooldown_seconds, channels: form.channel_ids, emails: parseRecipients(form.emails).emails })
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

  const saveEmails = async () => {
    if (!editing || recipientsError(editing.emails)) return;
    try {
      const res = await fetchWithAuth(`/api/alert-rules/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: parseRecipients(editing.emails).emails }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      setEditing(null);
      fetchData();
    } catch (err) {
      toast('Failed to save recipients', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
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
                  <Label htmlFor="alert-server">Server</Label>
                  <select id="alert-server" value={form.server_id} onChange={e => setForm({ ...form, server_id: e.target.value })} className="form-select">
                    <option value="">Any server</option>
                    {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-severity">Severity</Label>
                  <select id="alert-severity" value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} className="form-select">
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alert-metric">Metric</Label>
                  <select id="alert-metric" value={form.metric} onChange={e => setForm({ ...form, metric: e.target.value })} className="form-select">
                    {[...METRICS, ...serverMetrics].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
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
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="alert-emails">Email to (optional)</Label>
                  <Input id="alert-emails" type="text" inputMode="email" autoComplete="off" placeholder="ops@example.com, me@example.com"
                    value={form.emails} onChange={e => setForm({ ...form, emails: e.target.value })}
                    aria-invalid={!!formEmailError} aria-describedby="alert-emails-help" />
                  <p id="alert-emails-help" className={cn('text-xs', formEmailError ? 'text-destructive' : 'text-muted-foreground')}>
                    {formEmailError || 'Comma-separated addresses. Sent when email (SMTP) is enabled under Settings → General.'}
                  </p>
                </div>
                <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end lg:col-span-3">
                  <Button type="button" variant="outline" size="lg" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="lg" disabled={saving || !!formEmailError}>
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
                      {rule.server_name || 'Any server'}: {METRIC_LABEL[rule.metric] ?? rule.metric} {CONDITION_LABEL[rule.condition] ?? rule.condition} {rule.threshold} · {rule.severity || 'warning'} · cooldown {rule.cooldown_seconds}s{rule.trigger_count ? ` · fired ${rule.trigger_count}×` : ''}
                    </div>
                    {editing?.id === rule.id ? (
                      <form className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start" onSubmit={e => { e.preventDefault(); saveEmails(); }}>
                        <div className="min-w-0 flex-1 space-y-1">
                          <Input aria-label={`Email recipients for ${rule.name}`} inputMode="email" autoFocus placeholder="ops@example.com, me@example.com"
                            value={editing.emails} onChange={e => setEditing({ id: rule.id, emails: e.target.value })}
                            aria-invalid={!!recipientsError(editing.emails)} />
                          {recipientsError(editing.emails) && <p className="text-xs text-destructive">{recipientsError(editing.emails)}</p>}
                        </div>
                        <div className="flex gap-2">
                          <Button type="submit" disabled={!!recipientsError(editing.emails)}>Save</Button>
                          <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                        </div>
                      </form>
                    ) : (
                      <button type="button" onClick={() => setEditing({ id: rule.id, emails: (rule.emails || []).join(', ') })}
                        className="mt-1 flex max-w-full items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
                        aria-label={`Edit email recipients for ${rule.name}`}>
                        <Mail className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{rule.emails?.length ? rule.emails.join(', ') : 'No email recipients (add)'}</span>
                      </button>
                    )}
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
