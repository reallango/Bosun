'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { ProvisionSteps } from '@/components/settings/ProvisionSteps';
import { LeftoverKeysPanel } from '@/components/settings/LeftoverKeysPanel';

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
}

export default function NewServerPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setupMethod, setSetupMethod] = useState<'existing' | 'auto'>('existing');
  const [sshKeys, setSSHKeys] = useState<SSHKey[]>([]);
  
  // Auto-provision state
  const [provisioning, setProvisioning] = useState(false);
  const [provisionSteps, setProvisionSteps] = useState<string[]>([]);
  const [provisionError, setProvisionError] = useState('');
  const [provisionData, setProvisionData] = useState<any>(null);

  // Login used for provisioning, held in memory for the leftover-key cleanup (never stored or sent anywhere else).
  const [creds, setCreds] = useState<{ hostname: string; port: number; admin_username: string; admin_password: string; platform: string; service_account: string } | null>(null);
  const [leftover, setLeftover] = useState<{ fingerprint: string; comment: string }[]>([]);

  // Store provision form values for saving
  const [provisionForm, setProvisionForm] = useState({
    hostname: '',
    ssh_port: 22,
    name: '',
    platform: 'linux',
  });

  useEffect(() => {
    fetchWithAuth('/api/ssh-keys')
      .then(r => r.json())
      .then(j => { if (j.data) setSSHKeys(Array.isArray(j.data) ? j.data : j.data.ssh_keys || []); })
      .catch(() => setSSHKeys([]));
  }, []);

  const handleProvision = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProvisioning(true);
    setProvisionError('');
    setProvisionSteps([]);
    setProvisionData(null);

    const formData = new FormData(e.currentTarget);
    const hostname = formData.get('hostname') as string;
    const port = parseInt(formData.get('ssh_port') as string) || 22;
    const name = hostname; // Use hostname as default name
    const platform = (formData.get('platform') as string) || 'linux';
    const admin_username = formData.get('admin_username') as string;
    const admin_password = formData.get('admin_password') as string;
    const service_account = formData.get('service_account') as string || 'bosun-svc';
    const replace_keys = formData.get('replace_keys') === 'on';
    const create_shell_account = formData.get('create_shell_account') === 'on';
    const shell_account = (formData.get('shell_account') as string || 'bosun-user').trim();

    // Store form values for later save
    setProvisionForm({ hostname, ssh_port: port, name, platform });
    // Kept in memory only, while this page is open, so leftover keys can be removed without asking for the login again.
    setCreds({ hostname, port, admin_username, admin_password, platform, service_account });
    setLeftover([]);

    try {
      const res = await fetch('/api/servers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname, port, admin_username, admin_password, platform, service_account, replace_keys, create_shell_account, shell_account })
      });
      const data = await res.json();
      
      if (!res.ok) {
        setProvisionError(data.error?.message || 'Provisioning failed');
        return;
      }
      
      setProvisionSteps(data.data?.steps || []);
      setProvisionData(data.data);
      setLeftover(Array.isArray(data.data?.leftover_keys) ? data.data.leftover_keys : []);
    } catch (err) {
      setProvisionError(String(err));
    } finally {
      setProvisioning(false);
    }
  };

  const handleProvisionSave = async () => {
    if (!provisionData) return;
    // The host was already added to this Bosun: provisioning updated its key in place.
    if (provisionData.existing_server) {
      router.push('/settings/servers');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetchWithAuth('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: provisionForm.name || provisionForm.hostname,
          hostname: provisionForm.hostname,
          ssh_port: provisionForm.ssh_port,
          ssh_user: provisionData.service_account,
          ssh_key_id: provisionData.ssh_key_id,
          ...(provisionData.shell_user && provisionData.shell_key_id
            ? { shell_user: provisionData.shell_user, shell_key_id: provisionData.shell_key_id } : {}),
          platform: provisionForm.platform,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message || 'Failed to create server');
        return;
      }

      router.push('/settings/servers');
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          hostname: formData.get('hostname'),
          ssh_port: parseInt(formData.get('ssh_port') as string) || 22,
          ssh_user: formData.get('ssh_user'),
          ssh_key_id: formData.get('ssh_key_id') || null,
          notes: formData.get('notes'),
          platform: formData.get('platform') || 'linux',
          mac_address: formData.get('mac_address') || null,
          mac_address_alt: formData.get('mac_address_alt') || null
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message || 'Failed to create server');
        return;
      }

      router.push('/settings/servers');
    } catch (err) {
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Header title="Add Server" />
      <div className="page max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Add Server</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Setup Method Tabs */}
            <div role="tablist" aria-label="Setup method" className="mb-6 grid grid-cols-1 gap-2 xs:grid-cols-2">
              <Button
                size="lg"
                role="tab"
                aria-selected={setupMethod === 'existing'}
                className="h-auto min-h-9 whitespace-normal py-2"
                type="button"
                variant={setupMethod === 'existing' ? 'default' : 'outline'}
                onClick={() => setSetupMethod('existing')}
              >
                I have existing SSH credentials
              </Button>
              <Button
                size="lg"
                role="tab"
                aria-selected={setupMethod === 'auto'}
                className="h-auto min-h-9 whitespace-normal py-2"
                type="button"
                variant={setupMethod === 'auto' ? 'default' : 'outline'}
                onClick={() => { setSetupMethod('auto'); setProvisionData(null); setProvisionSteps([]); }}
              >
                Set up automatically
              </Button>
            </div>

            {setupMethod === 'auto' ? (
              <form onSubmit={handleProvision} className="space-y-4">
                {(provisionError || error) && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {provisionError || error}
                  </div>
                )}
                
                {provisionData ? (
                  // Show results after provisioning
                  <div className="space-y-4">
                    {error && (
                      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                        {error}
                      </div>
                    )}
                    <ProvisionSteps steps={provisionSteps} />
                    <LeftoverKeysPanel creds={creds} keepKeyId={provisionData.ssh_key_id} initial={leftover} />
                    <div className="break-words text-sm text-muted-foreground">
                      <p>Service account: <strong>{provisionData.service_account}</strong></p>
                      <p>SSH Key: <strong>{provisionData.ssh_key_name}</strong></p>
                      <p>Non-admin shell account (API terminals): <strong>{provisionData.shell_user || 'not enabled'}</strong></p>
                    </div>
                    <div className="flex flex-col-reverse gap-2 pt-2 xs:flex-row">
                      <Button
                        type="button"
                        onClick={handleProvisionSave}
                        disabled={loading}
                      >
                        {loading ? 'Saving...' : provisionData.existing_server ? 'Done' : 'Save Server'}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => router.back()}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="hostname">Hostname / IP *</Label>
                      <Input id="hostname" name="hostname" required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ssh_port">SSH Port</Label>
                      <Input id="ssh_port" name="ssh_port" type="number" defaultValue="22" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="platform">Platform</Label>
                      <select id="platform" name="platform" defaultValue="linux"
                        className="form-select">
                        <option value="linux">Linux</option>
                        <option value="windows">Windows</option>
                      </select>
                      <p className="text-xs text-muted-foreground">Windows hosts are provisioned with PowerShell over OpenSSH.</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="admin_username">Admin Username *</Label>
                      <Input id="admin_username" name="admin_username" placeholder="root or Administrator" required />
                      <p className="text-xs text-muted-foreground">SSH user with sudo (Linux) or Administrator (Windows) rights</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="admin_password">Admin Password *</Label>
                      <Input id="admin_password" name="admin_password" type="password" autoComplete="off" required />
                      <p className="text-xs text-muted-foreground">Password for admin user (used once, not stored)</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="service_account">Service Account Name</Label>
                      <Input id="service_account" name="service_account" defaultValue="bosun-svc" />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="replace_keys" className="flex items-start gap-2 text-sm font-medium">
                        <input id="replace_keys" name="replace_keys" type="checkbox" defaultChecked className="mt-1" />
                        <span>Replace earlier Bosun keys on this host</span>
                      </label>
                      <p className="pl-6 text-xs text-muted-foreground">
                        Removes keys a previous Bosun install added to the service account, once the new key is verified.
                        Use this when moving a host from an old Bosun; the old install loses access. On Windows only keys
                        labeled exactly for this host are removed.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="create_shell_account" className="flex items-start gap-2 text-sm font-medium">
                        <input id="create_shell_account" name="create_shell_account" type="checkbox" defaultChecked className="mt-1" />
                        <span>Create a non-admin shell account</span>
                      </label>
                      <div className="pl-6 space-y-2">
                        <Input id="shell_account" name="shell_account" defaultValue="bosun-user" aria-label="Shell account name" />
                        <p className="text-xs text-muted-foreground">
                          Used only by API keys that are granted terminal or command access. It has no administrator rights (no sudo or Docker group on Linux) and
                          no key to the admin account, and is checked by logging in as it before it is enabled. The web terminal
                          is unaffected: it always asks for your own login. On Windows it is a standard user (not an administrator).
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col-reverse gap-2 pt-2 xs:flex-row">
                      <Button type="submit" disabled={provisioning}>
                        {provisioning ? 'Provisioning...' : 'Provision Server'}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => router.back()}>
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input id="name" name="name" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hostname">Hostname / IP *</Label>
                  <Input id="hostname" name="hostname" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ssh_port">SSH Port</Label>
                  <Input id="ssh_port" name="ssh_port" type="number" defaultValue="22" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ssh_user">SSH User *</Label>
                  <Input id="ssh_user" name="ssh_user" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ssh_key_id">SSH Key</Label>
                  <select id="ssh_key_id" name="ssh_key_id" defaultValue=""
                    className="form-select">
                    <option value="">-- No key selected --</option>
                    {sshKeys.map(k => (
                      <option key={k.id} value={k.id}>
                        {k.name} ({k.fingerprint?.substring(0, 16)}...)
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">Required for widgets, Detect OS, and the terminal.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="platform">Platform</Label>
                  <select id="platform" name="platform" defaultValue="linux"
                    className="form-select">
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Windows hosts use PowerShell over OpenSSH.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="mac_address">Wake-on-LAN MAC</Label>
                    <Input id="mac_address" name="mac_address" placeholder="Detected automatically" className="font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mac_address_alt">Alternate MAC (wired/wireless)</Label>
                    <Input id="mac_address_alt" name="mac_address_alt" placeholder="Detected automatically" className="font-mono" />
                  </div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Leave empty: Bosun reads both from the network interfaces of the host on the first poll. Only fill them in to override.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Input id="notes" name="notes" />
                </div>
                <div className="flex flex-col-reverse gap-2 pt-2 xs:flex-row">
                  <Button type="submit" disabled={loading}>
                    {loading ? 'Creating...' : 'Create Server'}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => router.back()}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}