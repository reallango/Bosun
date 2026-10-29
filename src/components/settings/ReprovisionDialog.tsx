'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ProvisionSteps } from '@/components/settings/ProvisionSteps';
import { LeftoverKeysPanel, type LeftoverKey, type ProvisionCreds } from '@/components/settings/LeftoverKeysPanel';

export interface ReprovisionServer {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string | null;
  platform?: string;
  shell_user?: string | null;
  /** The service account name to start from (the current one when Bosun created it, otherwise bosun-svc). */
  service_account_default?: string;
}

/**
 * Set a server that is already added up again: fresh keys, the non-admin account created or repaired,
 * the old Bosun keys retired. Also the way to rotate keys after a possible leak. The administrator login
 * is asked for each time (it is used for this run only and never stored).
 */
export function ReprovisionDialog({ server, open, onOpenChange, onDone }: { server: ReprovisionServer | null; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const windows = server?.platform === 'windows';
  const [adminUser, setAdminUser] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [rotate, setRotate] = useState(true);
  const [createShell, setCreateShell] = useState(true);
  const [shellAccount, setShellAccount] = useState('bosun-user');
  const [serviceAccount, setServiceAccount] = useState('bosun-svc');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ steps: string[]; keyId: string; leftover: LeftoverKey[]; testSuccess: boolean } | null>(null);
  const [creds, setCreds] = useState<ProvisionCreds | null>(null);

  useEffect(() => {
    if (!open || !server) return;
    setAdminUser(server.platform === 'windows' ? 'Administrator' : 'root');
    setAdminPassword('');
    setRotate(true);
    setCreateShell(true);
    setShellAccount(server.shell_user || 'bosun-user');
    setServiceAccount(server.service_account_default || 'bosun-svc');
    setError('');
    setResult(null);
    setCreds(null);
    // Only when the dialog opens (or for another server): the parent builds `server` fresh on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server?.id]);

  if (!server) return null;

  const close = (o: boolean) => {
    if (running) return;
    if (!o && result) onDone();
    setAdminPassword('');
    setCreds(null);
    onOpenChange(o);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setError('');
    try {
      const res = await fetchWithAuth('/api/servers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: server.id,
          admin_username: adminUser.trim(),
          admin_password: adminPassword,
          replace_keys: rotate,
          create_shell_account: createShell,
          shell_account: shellAccount.trim(),
          service_account: serviceAccount.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error?.message || 'Re-provisioning failed'); return; }
      setCreds({ hostname: server.host, port: server.ssh_port, admin_username: adminUser.trim(), admin_password: adminPassword, platform: server.platform || 'linux', service_account: json.data?.service_account || server.ssh_user || 'bosun-svc' });
      setResult({ steps: json.data?.steps || [], keyId: json.data?.ssh_key_id, leftover: Array.isArray(json.data?.leftover_keys) ? json.data.leftover_keys : [], testSuccess: !!json.data?.test_success });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Re-provision {server.name}</DialogTitle>
          <DialogDescription>
            Sets this host up again with fresh keys, creates or repairs its non-admin shell account, and retires the old Bosun keys.
            Use it to repair a host, to pick up new features, or to rotate keys if you think a key may have leaked.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody className="space-y-4">
              <ProvisionSteps steps={result.steps} title={result.testSuccess ? 'Re-provisioned' : 'Finished with problems'} />
              <LeftoverKeysPanel creds={creds} keepKeyId={result.keyId} initial={result.leftover} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <DialogBody className="space-y-4">
              {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/40 p-3 text-sm">
                <dt className="text-muted-foreground">Host</dt><dd className="break-all">{server.host}:{server.ssh_port} ({windows ? 'Windows' : 'Linux'})</dd>
                <dt className="text-muted-foreground">Admin account</dt><dd>{server.ssh_user || 'bosun-svc'}</dd>
                <dt className="text-muted-foreground">Non-admin account</dt><dd>{server.shell_user || 'not set up yet'}</dd>
              </dl>
              <div className="space-y-1.5">
                <Label htmlFor="rp-svc">Admin (service) account name</Label>
                <Input id="rp-svc" value={serviceAccount} onChange={e => setServiceAccount(e.target.value)} required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">
                  Bosun&apos;s privileged account on the host. If this server was added with your own key and login, that login is left untouched
                  and this account is created instead. Changing the name creates the new account; the old one is not deleted (you are told how).
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rp-user">Admin username</Label>
                  <Input id="rp-user" value={adminUser} onChange={e => setAdminUser(e.target.value)} required />
                  <p className="text-xs text-muted-foreground">{windows ? 'A Windows administrator' : 'root, or a user with sudo'}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rp-pass">Admin password</Label>
                  <Input id="rp-pass" type="password" autoComplete="off" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} required />
                  <p className="text-xs text-muted-foreground">Used for this run only; never stored.</p>
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="rp-rotate" className="flex items-start gap-2 text-sm font-medium">
                  <input id="rp-rotate" type="checkbox" className="mt-1" checked={rotate} onChange={e => setRotate(e.target.checked)} />
                  <span>Rotate keys: retire the old Bosun keys on the host</span>
                </label>
                <p className="pl-6 text-xs text-muted-foreground">
                  New keys are always generated and proven to work first. With this on, the host&apos;s previous Bosun key is then removed (by the exact key)
                  and deleted from Bosun, so it can no longer log in; anything else still using it, such as another Bosun install, loses access.
                  With it off, the old key stays authorized next to the new one.
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="rp-shell" className="flex items-start gap-2 text-sm font-medium">
                  <input id="rp-shell" type="checkbox" className="mt-1" checked={createShell} onChange={e => setCreateShell(e.target.checked)} />
                  <span>Create or repair the non-admin account</span>
                </label>
                {createShell && (
                  <div className="pl-6">
                    <Input aria-label="Non-admin account name" value={shellAccount} onChange={e => setShellAccount(e.target.value)} />
                  </div>
                )}
              </div>
              <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-muted-foreground">
                If a key may have leaked, also change the host&apos;s administrator password, and check the host&apos;s authorized_keys files for keys you do not recognise:
                this only replaces the keys Bosun itself created.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={running}>Cancel</Button>
              <Button type="submit" disabled={running || !adminUser.trim() || !adminPassword || !serviceAccount.trim()}>{running ? 'Working…' : 'Re-provision'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
