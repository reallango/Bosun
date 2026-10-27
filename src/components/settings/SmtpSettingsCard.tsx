'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mail, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  user: string;
  has_password: boolean;
  from: string;
  app_url: string;
}

type ApiResult<T> = { data?: T; error?: { message?: string } };

const DEFAULT_PORT: Record<SmtpSettings['security'], number> = { none: 25, starttls: 587, tls: 465 };

/**
 * Outgoing email (admin): used for password reset links, email sign-in codes
 * and alert emails.
 */
export default function SmtpSettingsCard() {
  const { toast } = useToast();
  const [s, setS] = useState<SmtpSettings | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await readJson<ApiResult<SmtpSettings>>(await fetchWithAuth('/api/settings/smtp'));
      if (!j.data) throw new Error(j.error?.message || 'Failed to load');
      setS({ ...j.data, app_url: j.data.app_url || (typeof window !== 'undefined' ? window.location.origin : '') });
    } catch (err) {
      toast('Failed to load email settings', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const save = async (extra: Record<string, unknown> = {}) => {
    if (!s) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        host: s.host, port: s.port, security: s.security, user: s.user, from: s.from, app_url: s.app_url, enabled: s.enabled, ...extra,
      };
      if (password) body.password = password;
      const res = await fetchWithAuth('/api/settings/smtp', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await readJson<ApiResult<SmtpSettings>>(res);
      if (!res.ok || !j.data) throw new Error(j.error?.message || `HTTP ${res.status}`);
      setS(j.data);
      setPassword('');
      toast('Email settings saved', { variant: 'success' });
    } catch (err) {
      toast('Could not save email settings', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const res = await fetchWithAuth('/api/settings/smtp/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: testTo }),
      });
      const j = await readJson<ApiResult<{ sent: boolean }>>(res);
      if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
      toast('Test email sent', { variant: 'success', description: `Check the inbox of ${testTo}` });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Sending failed');
    } finally {
      setTesting(false);
    }
  };

  const set = (patch: Partial<SmtpSettings>) => setS(cur => (cur ? { ...cur, ...patch } : cur));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Mail className="size-4" aria-hidden /> Email (SMTP)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!s ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={e => { e.preventDefault(); save(); }}
          >
            <p className="text-muted-foreground">
              Used for password reset links, email sign-in codes and alert emails. Save, send a test email, then enable.
            </p>
            <fieldset disabled={saving} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="smtp-enabled">Outgoing email</Label>
                <select id="smtp-enabled" className="form-select" value={s.enabled ? 'true' : 'false'}
                  onChange={e => set({ enabled: e.target.value === 'true' })}>
                  <option value="false">Disabled</option>
                  <option value="true">Enabled</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">SMTP server</Label>
                <Input id="smtp-host" value={s.host} placeholder="smtp.example.com" autoComplete="off"
                  onChange={e => set({ host: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="smtp-security">Security</Label>
                  <select id="smtp-security" className="form-select" value={s.security}
                    onChange={e => {
                      const security = e.target.value as SmtpSettings['security'];
                      const isDefault = Object.values(DEFAULT_PORT).includes(Number(s.port));
                      set({ security, ...(isDefault ? { port: DEFAULT_PORT[security] } : {}) });
                    }}>
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS (SMTPS)</option>
                    <option value="none">None</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="smtp-port">Port</Label>
                  <Input id="smtp-port" type="number" inputMode="numeric" min={1} max={65535} value={s.port}
                    onChange={e => set({ port: Number(e.target.value) })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">Username</Label>
                <Input id="smtp-user" value={s.user} autoComplete="off" placeholder="(no authentication)"
                  onChange={e => set({ user: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-password">Password</Label>
                <Input id="smtp-password" type="password" value={password} autoComplete="new-password"
                  placeholder={s.has_password ? '•••••••• (saved, leave blank to keep)' : ''}
                  onChange={e => setPassword(e.target.value)} />
                {s.has_password && (
                  <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => save({ clear_password: true })}>
                    Remove saved password
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from">Sender (From)</Label>
                <Input id="smtp-from" value={s.from} placeholder="Bosun <bosun@example.com>"
                  onChange={e => set({ from: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-app-url">Public URL of Bosun</Label>
                <Input id="smtp-app-url" type="url" value={s.app_url} placeholder="https://bosun.example.com"
                  onChange={e => set({ app_url: e.target.value })} />
                <p className="text-xs text-muted-foreground">Used in emailed links such as password reset.</p>
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="lg" disabled={saving}>{saving ? 'Saving…' : 'Save email settings'}</Button>
            </div>
          </form>
        )}
        {s && (
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="smtp-test-to">Send a test email (uses the saved settings)</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="smtp-test-to" type="email" value={testTo} placeholder="you@example.com"
                onChange={e => setTestTo(e.target.value)} className="sm:max-w-xs" />
              <Button type="button" variant="outline" size="lg" disabled={testing || !testTo || !s.host} onClick={sendTest}>
                <Send /> {testing ? 'Sending…' : 'Send test'}
              </Button>
            </div>
            {testError && (
              <div role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {testError}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
