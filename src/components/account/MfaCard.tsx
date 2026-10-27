'use client';

import { useState } from 'react';
import { Copy, Download, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { mfaAction, type Account } from './api';

type Flow =
  | { kind: 'idle' }
  | { kind: 'totp'; secret: string; uri: string; qrSvg: string }
  | { kind: 'email'; challengeId: string | null }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'regenerate' }
  | { kind: 'disable'; challengeId: string | null };

const METHOD_LABEL = { none: 'Off', totp: 'Authenticator app', email: 'Email codes' } as const;

function ErrorBox({ message }: { message: string }) {
  return <div role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>;
}

function CodeInput({ id, value, onChange, label, allowBackup }: { id: string; value: string; onChange: (v: string) => void; label: string; allowBackup?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={e => onChange(e.target.value)} required autoComplete="one-time-code"
        inputMode={allowBackup ? 'text' : 'numeric'} maxLength={allowBackup ? 20 : 7} placeholder={allowBackup ? '123456 or xxxxx-xxxxx' : '123456'}
        className="max-w-xs font-mono tracking-widest" />
    </div>
  );
}

function BackupCodes({ codes, username, onDone }: { codes: string[]; username: string; onDone: () => void }) {
  const { toast } = useToast();
  const text = `Bosun backup codes for ${username}\nEach code can be used once.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Backup codes copied', { variant: 'success' });
    } catch {
      toast('Copy failed: select the codes and copy them manually', { variant: 'error' });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `bosun-backup-codes-${username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <p className="font-medium">Save your backup codes</p>
      <p className="text-muted-foreground">
        Each code signs you in once if you lose access to your second factor. They are shown only now.
      </p>
      <ul className="grid grid-cols-1 gap-1.5 font-mono text-base min-[400px]:grid-cols-2">
        {codes.map(c => <li key={c} className="rounded bg-background px-2 py-1 text-center">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copy}><Copy /> Copy</Button>
        <Button type="button" variant="outline" onClick={download}><Download /> Download</Button>
        <Button type="button" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

export function MfaCard({ account, reload }: { account: Account; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = (next: Flow = { kind: 'idle' }) => {
    setFlow(next);
    setCode('');
    setPassword('');
    setError('');
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const startTotp = () => run(async () => {
    const d = await mfaAction<{ secret: string; otpauth_uri: string; qr_svg: string }>('totp-setup');
    reset({ kind: 'totp', secret: d.secret, uri: d.otpauth_uri, qrSvg: d.qr_svg });
  });

  const confirmTotp = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const d = await mfaAction<{ backup_codes: string[] }>('totp-enable', { code });
      reset({ kind: 'codes', codes: d.backup_codes });
      toast('Authenticator app enabled', { variant: 'success' });
      await reload();
    });
  };

  const sendEmailCode = () => run(async () => {
    const d = await mfaAction<{ challenge_id: string }>('email-start');
    setFlow({ kind: 'email', challengeId: d.challenge_id });
    setCode('');
    toast('Code sent', { description: `Check ${account.email}` });
  });

  const confirmEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (flow.kind !== 'email' || !flow.challengeId) return;
    const challengeId = flow.challengeId;
    run(async () => {
      const d = await mfaAction<{ backup_codes: string[] }>('email-enable', { challenge_id: challengeId, code });
      reset({ kind: 'codes', codes: d.backup_codes });
      toast('Email sign-in codes enabled', { variant: 'success' });
      await reload();
    });
  };

  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const d = await mfaAction<{ backup_codes: string[] }>('backup-codes', { password });
      reset({ kind: 'codes', codes: d.backup_codes });
      await reload();
    });
  };

  const sendDisableCode = () => run(async () => {
    const d = await mfaAction<{ challenge_id: string }>('disable-start');
    setFlow({ kind: 'disable', challengeId: d.challenge_id });
    toast('Code sent', { description: `Check ${account.email}` });
  });

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    const challengeId = flow.kind === 'disable' ? flow.challengeId : null;
    run(async () => {
      await mfaAction('disable', { password, code, challenge_id: challengeId });
      reset();
      toast('Two-step verification turned off', { variant: 'success' });
      await reload();
    });
  };

  const emailBlocked = !account.smtp_enabled
    ? 'Email is not configured on this Bosun (ask an administrator to set up SMTP).'
    : !account.email ? 'Add an email address to your profile first.' : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" aria-hidden /> Two-step verification</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Status:</span>
          <span className={account.mfa_method === 'none' ? 'font-medium text-muted-foreground' : 'font-medium text-success'}>
            {METHOD_LABEL[account.mfa_method]}
          </span>
          {account.mfa_method !== 'none' && (
            <span className="text-muted-foreground">· {account.backup_codes_remaining} backup code{account.backup_codes_remaining === 1 ? '' : 's'} left</span>
          )}
        </div>
        {error && <ErrorBox message={error} />}

        {flow.kind === 'codes' && <BackupCodes codes={flow.codes} username={account.username} onDone={() => reset()} />}

        {account.mfa_method === 'none' && flow.kind === 'idle' && (
          <>
            <p className="text-muted-foreground">Ask for a code after your password when signing in.</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button type="button" size="lg" onClick={startTotp} disabled={busy}><Smartphone /> Use an authenticator app</Button>
              <Button type="button" size="lg" variant="outline" onClick={() => reset({ kind: 'email', challengeId: null })} disabled={busy || !!emailBlocked}>
                <Mail /> Use email codes
              </Button>
            </div>
            {emailBlocked && <p className="text-xs text-muted-foreground">Email codes: {emailBlocked}</p>}
          </>
        )}

        {flow.kind === 'totp' && (
          <form onSubmit={confirmTotp} className="space-y-4">
            <p>Scan the QR code with an authenticator app (Aegis, Google Authenticator, 1Password, …), then enter the 6-digit code it shows.</p>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(flow.qrSvg)}`}
                alt="QR code for the authenticator app"
                className="size-44 shrink-0 rounded-md bg-white p-2"
              />
              <div className="min-w-0 space-y-2">
                <div>
                  <div className="text-xs text-muted-foreground">Or enter this key manually</div>
                  <code className="block break-all font-mono text-base tracking-wider">{flow.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">otpauth URI</summary>
                  <code className="mt-1 block break-all text-xs">{flow.uri}</code>
                </details>
              </div>
            </div>
            <CodeInput id="totp-confirm" label="Code from the app" value={code} onChange={setCode} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Turn on'}</Button>
              <Button type="button" size="lg" variant="outline" onClick={() => reset()}>Cancel</Button>
            </div>
          </form>
        )}

        {flow.kind === 'email' && (
          <form onSubmit={confirmEmail} className="space-y-4">
            <p>We will email a 6-digit code to <span className="font-medium">{account.email}</span> to confirm the address.</p>
            {flow.challengeId && <CodeInput id="email-confirm" label="Code from the email" value={code} onChange={setCode} />}
            <div className="flex flex-wrap gap-2">
              {flow.challengeId && <Button type="submit" size="lg" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Turn on'}</Button>}
              <Button type="button" size="lg" variant={flow.challengeId ? 'outline' : 'default'} onClick={sendEmailCode} disabled={busy}>
                {flow.challengeId ? 'Send a new code' : busy ? 'Sending…' : 'Send code'}
              </Button>
              <Button type="button" size="lg" variant="outline" onClick={() => reset()}>Cancel</Button>
            </div>
          </form>
        )}

        {account.mfa_method !== 'none' && flow.kind === 'idle' && (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="button" variant="outline" size="lg" onClick={() => reset({ kind: 'regenerate' })}>New backup codes</Button>
            <Button type="button" variant="outline" size="lg" className="text-destructive" onClick={() => reset({ kind: 'disable', challengeId: null })}>
              Turn off
            </Button>
          </div>
        )}

        {flow.kind === 'regenerate' && (
          <form onSubmit={regenerate} className="space-y-4">
            <p>New backup codes replace all old ones.</p>
            <div className="space-y-1.5">
              <Label htmlFor="regen-pw">Current password</Label>
              <Input id="regen-pw" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" className="max-w-xs" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={busy}>Generate</Button>
              <Button type="button" size="lg" variant="outline" onClick={() => reset()}>Cancel</Button>
            </div>
          </form>
        )}

        {flow.kind === 'disable' && (
          <form onSubmit={disable} className="space-y-4">
            <p>
              Confirm with your password and {account.mfa_method === 'totp' ? 'a code from your authenticator app' : 'an emailed code'} (or a backup code).
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="disable-pw">Current password</Label>
              <Input id="disable-pw" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" className="max-w-xs" />
            </div>
            <CodeInput id="disable-code" label="Verification or backup code" value={code} onChange={setCode} allowBackup />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" variant="destructive" disabled={busy || !code.trim()}>Turn off</Button>
              {account.mfa_method === 'email' && (
                <Button type="button" size="lg" variant="outline" onClick={sendDisableCode} disabled={busy}>
                  {flow.challengeId ? 'Send a new code' : 'Email me a code'}
                </Button>
              )}
              <Button type="button" size="lg" variant="outline" onClick={() => reset()}>Cancel</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
