'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export default function ForgotPasswordForm() {
  const [identifier, setIdentifier] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const value = identifier.trim();
      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value.includes('@') ? { email: value } : { username: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error?.message || 'Request failed');
        return;
      }
      setDone(json?.data?.message || 'If the account exists, a reset link has been sent.');
    } catch {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <>
            <p role="status" className="text-sm">{done}</p>
            <p className="text-sm text-muted-foreground">
              No email? Email may not be configured on this Bosun, or the account has no address. Ask an administrator to reset your password.
            </p>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
            )}
            <p className="text-sm text-muted-foreground">Enter your username or email address. We will email you a link to choose a new password.</p>
            <div className="space-y-2">
              <Label htmlFor="identifier">Username or email</Label>
              <Input id="identifier" value={identifier} onChange={e => setIdentifier(e.target.value)} required autoComplete="username" autoFocus />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={loading || !identifier.trim()}>
              {loading ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        )}
        <p className="text-center text-sm">
          <Link href="/login" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Back to sign in</Link>
        </p>
      </CardContent>
    </Card>
  );
}
