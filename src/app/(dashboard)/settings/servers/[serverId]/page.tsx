'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { useToast } from '@/components/ui/toast';
import { DeleteConfirmDialog } from '@/components/dialogs/DeleteConfirmDialog';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { WakeButton } from '@/components/servers/WakeButton';
import { MacAddressFields, MacValue } from '@/components/servers/MacAddressFields';
import { ReprovisionDialog } from '@/components/settings/ReprovisionDialog';

export default function EditServerPage() {
    const { serverId } = useParams<{ serverId: string }>();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [sshKeys, setSSHKeys] = useState<{ id: string; name: string; fingerprint: string }[]>([]);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [busy, setBusy] = useState<'test' | 'detect' | null>(null);
    // Pinned SSH host key and the poller's last error (read-only status).
    const [hostKey, setHostKey] = useState<string | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const { toast } = useToast();
    // The non-admin account Bosun created for this server (read-only here: it is managed by Re-provision).
    const [shell, setShell] = useState<{ user: string | null; keyId: string | null }>({ user: null, keyId: null });
    const [reprovisionOpen, setReprovisionOpen] = useState(false);
    const [version, setVersion] = useState(0);
    const [form, setForm] = useState({
        name: '', hostname: '', ssh_port: 22, ssh_user: '', ssh_key_id: '', notes: '', platform: 'linux',
        poll_enabled: true, poll_interval_sec: 15, mac_address: null as MacValue, mac_address_alt: null as MacValue,
    });

    useEffect(() => {
        fetchWithAuth(`/api/servers/${serverId}`)
            .then(r => r.json())
            .then(j => {
                if (j.data) setForm({
                    name: j.data.name || '',
                    hostname: j.data.hostname || '',
                    ssh_port: j.data.ssh_port || 22,
                    ssh_user: j.data.ssh_user || '',
                    ssh_key_id: j.data.ssh_key_id || '',
                    notes: j.data.notes || '',
                    platform: j.data.platform || 'linux',
                    poll_enabled: j.data.poll_enabled === undefined ? true : Number(j.data.poll_enabled) === 1,
                    poll_interval_sec: Number(j.data.poll_interval_sec) || 15,
                    mac_address: j.data.mac_address ?? null,
                    mac_address_alt: j.data.mac_address_alt ?? null,
                });
                if (j.data) {
                    setHostKey(j.data.host_key_fingerprint || null);
                    setLastError(j.data.last_error || null);
                    setShell({ user: j.data.shell_user || null, keyId: j.data.shell_key_id || null });
                }
            })
            .finally(() => setLoading(false));

        fetchWithAuth('/api/ssh-keys')
            .then(r => r.json())
            .then(j => { if (j.data) setSSHKeys(Array.isArray(j.data) ? j.data : j.data.ssh_keys || []); })
            .catch(() => {});
    }, [serverId, version]);

    const save = async () => {
        setSaving(true); setError('');
        try {
            const r = await fetchWithAuth(`/api/servers/${serverId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!r.ok) { const d = await r.json(); setError(d.error?.message || 'Failed'); return; }
            router.push('/settings/servers');
        } catch { setError('Network error'); }
        finally { setSaving(false); }
    };

    const del = async () => {
        await fetchWithAuth(`/api/servers/${serverId}`, { method: 'DELETE' });
        router.push('/settings/servers');
    };

    const test = async () => {
        setBusy('test');
        try {
            const r = await fetchWithAuth(`/api/servers/${serverId}/test`, { method: 'POST' });
            const d = await r.json();
            if (d.data?.success) toast('Connection OK', { variant: 'success', description: `Latency: ${d.data.latencyMs}ms` });
            else toast('Connection failed', { variant: 'error', description: d.error?.message });
        } catch {
            toast('Connection failed', { variant: 'error', description: 'Network error' });
        } finally {
            setBusy(null);
        }
    };

    const detect = async () => {
        setBusy('detect');
        try {
            const r = await fetchWithAuth(`/api/servers/${serverId}/detect`, { method: 'POST' });
            const d = await r.json();
            if (d.data) {
                toast('OS detected', {
                    variant: 'success',
                    duration: 10000,
                    description: `OS: ${d.data.os_type} ${d.data.os_version}
Kernel: ${d.data.kernel_version}
CPU: ${d.data.cpu_model} (${d.data.cpu_cores} cores)
RAM: ${d.data.total_ram_mb} MB`,
                });
            } else {
                toast('Detection failed', { variant: 'error', description: d.error?.message });
            }
        } catch {
            toast('Detection failed', { variant: 'error', description: 'Network error' });
        } finally {
            setBusy(null);
        }
    };

    if (loading) {
        return <><Header title="Edit Server" /><div className="page"><LoadingSpinner /></div></>;
    }

    return (
        <>
            <Header title={`Edit: ${form.name}`} />
            <div className="page max-w-2xl">
                <Card>
                    <CardHeader><CardTitle>Server Configuration</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}

                        <div>
                            <Label htmlFor="name">Name *</Label>
                            <Input id="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        </div>

                        <div>
                            <Label htmlFor="hostname">Hostname / IP *</Label>
                            <Input id="hostname" value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))} />
                        </div>

                        <div className="grid grid-cols-1 gap-4 xs:grid-cols-[8rem_1fr]">
                            <div>
                                <Label htmlFor="ssh_port">SSH Port</Label>
                                <Input id="ssh_port" type="number" value={form.ssh_port}
                                    onChange={e => setForm(f => ({ ...f, ssh_port: parseInt(e.target.value) || 22 }))} />
                            </div>
                            <div>
                                <Label htmlFor="platform">Platform</Label>
                                <select id="platform" value={form.platform}
                                    onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                                    className="form-select">
                                    <option value="linux">Linux</option>
                                    <option value="windows">Windows</option>
                                </select>
                            </div>
                        </div>

                        <fieldset className="space-y-3 rounded-md border p-3">
                            <legend className="px-1 text-sm font-medium">
                                Admin account <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-primary">admin</span>
                            </legend>
                            <p className="text-xs text-muted-foreground">
                                What Bosun uses to monitor this host and run actions that need elevated rights (the service account).
                            </p>
                            <div>
                                <Label htmlFor="ssh_user">Admin user *</Label>
                                <Input id="ssh_user" value={form.ssh_user}
                                    onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))} />
                            </div>
                            <div>
                                <Label htmlFor="ssh_key">Admin SSH key</Label>
                                <select id="ssh_key" value={form.ssh_key_id}
                                    onChange={e => setForm(f => ({ ...f, ssh_key_id: e.target.value }))}
                                    className="form-select">
                                    <option value="">-- No key selected --</option>
                                    {sshKeys.map(k => (
                                        <option key={k.id} value={k.id}>
                                            {k.name} ({k.fingerprint?.substring(0, 16)}...)
                                        </option>
                                    ))}
                                </select>
                                {form.platform === 'windows' && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                        On Windows, place this key in <code>C:\ProgramData\ssh\administrators_authorized_keys</code>.
                                    </p>
                                )}
                            </div>
                        </fieldset>

                        {shell.user ? (
                            <fieldset className="space-y-3 rounded-md border p-3">
                                <legend className="px-1 text-sm font-medium">
                                    Non-admin account <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">non-admin</span>
                                </legend>
                                <p className="text-xs text-muted-foreground">
                                    Used for API terminals, API shell commands and Custom Command widgets. It has no administrator rights. Managed by Re-provision below.
                                </p>
                                <div>
                                    <Label htmlFor="shell_user">Non-admin user</Label>
                                    <Input id="shell_user" value={shell.user} readOnly />
                                </div>
                                <div>
                                    <Label htmlFor="shell_key">Non-admin SSH key</Label>
                                    <select id="shell_key" value={shell.keyId || ''} disabled className="form-select">
                                        <option value="">-- No key --</option>
                                        {sshKeys.map(k => (
                                            <option key={k.id} value={k.id}>
                                                {k.name} ({k.fingerprint?.substring(0, 16)}...)
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </fieldset>
                        ) : (
                            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                                No non-admin account yet. Re-provision (below) can create one for API terminals, API shell commands and Custom Command widgets.
                            </p>
                        )}

                        <div className="grid grid-cols-1 gap-4 xs:grid-cols-2">
                            <div>
                                <Label htmlFor="poll_interval">Poll interval (seconds)</Label>
                                <Input id="poll_interval" type="number" min={5} max={3600} value={form.poll_interval_sec}
                                    onChange={e => setForm(f => ({ ...f, poll_interval_sec: parseInt(e.target.value) || 15 }))} />
                                <p className="mt-1 text-xs text-muted-foreground">One batched collection per poll over a persistent connection.</p>
                            </div>
                            <label className="flex items-center gap-2 self-center text-sm">
                                <input type="checkbox" checked={form.poll_enabled}
                                    onChange={e => setForm(f => ({ ...f, poll_enabled: e.target.checked }))} />
                                Monitoring enabled
                            </label>
                        </div>

                        <div className="rounded-md border p-3 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium">SSH host key</span>
                                {hostKey && (
                                    <Button variant="outline" size="sm" onClick={async () => {
                                        const r = await fetchWithAuth(`/api/servers/${serverId}`, {
                                            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ host_key_fingerprint: null }),
                                        });
                                        if (r.ok) { setHostKey(null); toast('Host key cleared', { variant: 'success', description: 'The next connection trusts and pins the key the host presents.' }); }
                                        else toast('Could not clear host key', { variant: 'error' });
                                    }}>Reset pinned key</Button>
                                )}
                            </div>
                            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                                {hostKey || 'Not pinned yet (pinned on first connection)'}
                            </p>
                            {lastError && <p className="mt-2 break-words text-xs text-destructive">Last poll error: {lastError}</p>}
                        </div>

                        <MacAddressFields serverId={serverId} mac={form.mac_address} macAlt={form.mac_address_alt}
                            onChange={(mac, alt) => setForm(f => ({ ...f, mac_address: mac, mac_address_alt: alt }))} />

                        <div>
                            <Label htmlFor="notes">Notes</Label>
                            <Input id="notes" value={form.notes}
                                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                        </div>

                        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap">
                            <Button size="lg" onClick={save} disabled={saving}>
                                {saving ? 'Saving…' : 'Save changes'}
                            </Button>
                            <Button size="lg" variant="outline" onClick={test} disabled={busy !== null}>
                                {busy === 'test' ? 'Testing…' : 'Test connection'}
                            </Button>
                            <Button size="lg" variant="outline" onClick={detect} disabled={busy !== null}>
                                {busy === 'detect' ? 'Detecting…' : 'Detect OS'}
                            </Button>
                            <WakeButton serverId={serverId} serverName={form.name} macAddress={form.mac_address || form.mac_address_alt || undefined} size="lg" />
                            <div className="hidden flex-1 sm:block" />
                            <Button size="lg" variant="destructive" onClick={() => setConfirmDelete(true)}>Delete server</Button>
                        </div>

                        <div className="space-y-2 rounded-md border p-3 text-sm">
                            <div className="font-medium">Re-provision / rotate keys</div>
                            <p className="text-xs text-muted-foreground">
                                Sets this host up again with fresh keys, creates or repairs the non-admin account, and retires the old Bosun keys.
                                Use it to repair provisioning, pick up new features, rename the admin account, or rotate keys if you think a key may have leaked.
                                You enter the administrator login for this run; it is not stored.
                            </p>
                            <Button variant="outline" onClick={() => setReprovisionOpen(true)} disabled={saving}>Re-provision…</Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
            <ReprovisionDialog
                server={{
                    id: serverId, name: form.name, host: form.hostname, ssh_port: form.ssh_port, ssh_user: form.ssh_user, platform: form.platform, shell_user: shell.user,
                    // Reuse the account name only when Bosun created it (its key is labeled <host>-<account>); otherwise start from bosun-svc.
                    service_account_default: sshKeys.find(k => k.id === form.ssh_key_id)?.name === `${form.hostname}-${form.ssh_user}` ? form.ssh_user : 'bosun-svc',
                }}
                open={reprovisionOpen}
                onOpenChange={setReprovisionOpen}
                onDone={() => setVersion(v => v + 1)}
            />
            <DeleteConfirmDialog
                title="Delete server?"
                confirmLabel="Delete"
                widgetTitle={form.name || 'this server'}
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                onConfirm={del}
            />
        </>
    );
}