'use client';

import { useEffect, useState } from 'react';
import { KeyRound, UserRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { accountApi, type Account } from './api';

export function ProfileCard({ account, onChange }: { account: Account; onChange: (a: Account) => void }) {
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState(account.display_name);
  const [email, setEmail] = useState(account.email);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(account.display_name);
    setEmail(account.email);
  }, [account.display_name, account.email]);

  const emailChanged = email.trim() !== account.email;
  const dirty = emailChanged || displayName.trim() !== account.display_name;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, string> = { display_name: displayName };
      if (emailChanged) Object.assign(body, { email, current_password: password });
      onChange(await accountApi<Account>('/api/auth/account', 'PATCH', body));
      setPassword('');
      toast('Profile saved', { variant: 'success' });
    } catch (err) {
      toast('Could not save profile', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserRound className="size-4" aria-hidden /> Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acct-username">Username</Label>
            <Input id="acct-username" value={account.username} readOnly className="bg-muted/50" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-role">Access level</Label>
            <Input id="acct-role" value={account.role} readOnly className="bg-muted/50 capitalize" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-display">Display name</Label>
            <Input id="acct-display" value={displayName} maxLength={100} onChange={e => setDisplayName(e.target.value)} autoComplete="name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-email">Email</Label>
            <Input id="acct-email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
            <p className="text-xs text-muted-foreground">Used for password reset links and email sign-in codes.</p>
          </div>
          {emailChanged && (
            <div className="space-y-1.5 sm:col-span-2 sm:max-w-sm">
              <Label htmlFor="acct-email-pw">Current password (required to change the email)</Label>
              <Input id="acct-email-pw" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" size="lg" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save profile'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PasswordCard({ account }: { account: Account }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('The new passwords do not match');
      return;
    }
    setSaving(true);
    try {
      await accountApi('/api/auth/account/password', 'POST', { current_password: current, new_password: next });
      setCurrent(''); setNext(''); setConfirm('');
      toast('Password changed', { variant: 'success', description: 'Your other sessions were signed out.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden /> Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* Lets password managers associate the change with the account. */}
          <input type="text" name="username" value={account.username} autoComplete="username" readOnly hidden />
          {error && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive sm:col-span-3">{error}</div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <Input id="pw-current" type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoComplete="current-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">Repeat new password</Label>
            <Input id="pw-confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-3 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</Button>
            <p className="text-xs text-muted-foreground">
              At least 8 characters. Signs out your other sessions.
              {account.password_changed_at ? ` Last changed ${new Date(account.password_changed_at).toLocaleString()}.` : ''}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
