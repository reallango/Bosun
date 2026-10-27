'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface MfaStep {
  challengeId: string;
  method: 'totp' | 'email';
  emailSent?: boolean;
}

interface ApiError { message?: string; code?: string; attempts_left?: number }

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: ApiError }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json?.data, error: json?.error };
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {children}
    </div>
  );
}

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [mfa, setMfa] = useState<MfaStep | null>(null);
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const r = await postJson('/api/auth/login', { username, password });
      if (!r.ok) {
        setError(r.error?.message || 'Login failed');
        return;
      }
      if (r.data?.mfa_required) {
        const step: MfaStep = {
          challengeId: String(r.data.challenge_id),
          method: r.data.method === 'email' ? 'email' : 'totp',
          emailSent: r.data.email_sent !== false,
        };
        setMfa(step);
        setPassword('');
        setCode('');
        setUseBackup(false);
        if (step.method === 'email' && !step.emailSent) {
          setError('The sign-in code could not be emailed. Try resending it, or use a backup code.');
        }
        return;
      }
      router.push('/');
    } catch {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const startOver = (message = '') => {
    setMfa(null);
    setCode('');
    setUseBackup(false);
    setInfo('');
    setError(message);
  };

  const handleCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfa) return;
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const r = await postJson('/api/auth/mfa', { challenge_id: mfa.challengeId, code });
      if (!r.ok) {
        if (r.error?.code === 'CHALLENGE_EXPIRED') {
          startOver(r.error.message || 'Sign in again.');
          return;
        }
        const left = r.error?.attempts_left;
        setError(`${r.error?.message || 'Invalid code'}${typeof left === 'number' ? ` (${left} attempt${left === 1 ? '' : 's'} left)` : ''}`);
        setCode('');
        return;
      }
      router.push('/');
    } catch {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (!mfa) return;
    setError('');
    setInfo('');
    try {
      const r = await postJson('/api/auth/mfa/resend', { challenge_id: mfa.challengeId });
      if (!r.ok) {
        if (r.error?.code === 'CHALLENGE_EXPIRED') return startOver(r.error.message || 'Sign in again.');
        setError(r.error?.message || 'Could not resend the code');
        return;
      }
      if (r.data?.email_sent === false) setError('The code could not be emailed. Use a backup code, or contact an administrator.');
      else setInfo('A new code has been sent.');
    } catch {
      setError('An error occurred');
    }
  };

  if (mfa) {
    const backup = useBackup;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Two-step verification</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCode} className="space-y-4">
            {error && <ErrorBox>{error}</ErrorBox>}
            {info && <p role="status" className="text-sm text-success">{info}</p>}
            <p className="text-sm text-muted-foreground">
              {backup
                ? 'Enter one of your backup codes. Each code works only once.'
                : mfa.method === 'totp'
                  ? 'Enter the 6-digit code from your authenticator app.'
                  : 'We emailed a 6-digit code to the address on your account.'}
            </p>
            <div className="space-y-2">
              <Label htmlFor="mfa-code">{backup ? 'Backup code' : 'Verification code'}</Label>
              <Input
                id="mfa-code"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode={backup ? 'text' : 'numeric'}
                pattern={backup ? undefined : '[0-9 ]{6,7}'}
                maxLength={backup ? 20 : 7}
                placeholder={backup ? 'xxxxx-xxxxx' : '123456'}
                className="text-center font-mono text-lg tracking-widest"
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={loading || !code.trim()}>
              {loading ? 'Verifying…' : 'Verify'}
            </Button>
            <div className="flex flex-col items-center gap-2 text-sm sm:flex-row sm:justify-between">
              <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => { setUseBackup(!backup); setCode(''); setError(''); }}>
                {backup ? 'Use a verification code' : 'Use a backup code'}
              </button>
              {mfa.method === 'email' && !backup && (
                <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={resend}>
                  Resend code
                </button>
              )}
              <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => startOver()}>
                Cancel
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign In</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="password">Password</Label>
              <Link href="/forgot-password" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
