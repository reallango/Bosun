'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

export default function EditServerPage() {
    const { serverId } = useParams<{ serverId: string }>();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [sshKeys, setSSHKeys] = useState<{ id: string; name: string; fingerprint: string }[]>([]);
    const [form, setForm] = useState({
        name: '', hostname: '', ssh_port: 22, ssh_user: '', ssh_key_id: '', notes: '', portainer_url: '',
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
                    portainer_url: j.data.portainer_url || '',
                });
            })
            .finally(() => setLoading(false));

        fetchWithAuth('/api/ssh-keys')
            .then(r => r.json())
            .then(j => { if (j.data) setSSHKeys(Array.isArray(j.data) ? j.data : j.data.ssh_keys || []); })
            .catch(() => {});
    }, [serverId]);

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
        if (!confirm('Delete this server? This cannot be undone.')) return;
        await fetchWithAuth(`/api/servers/${serverId}`, { method: 'DELETE' });
        router.push('/settings/servers');
    };

    const test = async () => {
        const r = await fetchWithAuth(`/api/servers/${serverId}/test`, { method: 'POST' });
        const d = await r.json();
        alert(d.data?.success
            ? `✅ Connection OK! Latency: ${d.data.latencyMs}ms`
            : `❌ Failed: ${d.error?.message}`);
    };

    const detect = async () => {
        const r = await fetchWithAuth(`/api/servers/${serverId}/detect`, { method: 'POST' });
        const d = await r.json();
        alert(d.data
            ? `✅ Detected:\nOS: ${d.data.os_type} ${d.data.os_version}\nKernel: ${d.data.kernel_version}\nCPU: ${d.data.cpu_model} (${d.data.cpu_cores} cores)\nRAM: ${d.data.total_ram_mb} MB`
            : `❌ Failed: ${d.error?.message}`);
    };

    if (loading) {
        return <><Header title="Edit Server" /><div className="p-6 text-muted-foreground">Loading...</div></>;
    }

    return (
        <>
            <Header title={`Edit: ${form.name}`} />
            <div className="p-6 max-w-2xl">
                <Card>
                    <CardHeader><CardTitle>Server Configuration</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        {error && <div className="text-red-500 text-sm p-2 bg-red-50 dark:bg-red-950 rounded">{error}</div>}

                        <div>
                            <Label htmlFor="name">Name *</Label>
                            <Input id="name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        </div>

                        <div>
                            <Label htmlFor="hostname">Hostname / IP *</Label>
                            <Input id="hostname" value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))} />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="ssh_port">SSH Port</Label>
                                <Input id="ssh_port" type="number" value={form.ssh_port}
                                    onChange={e => setForm(f => ({ ...f, ssh_port: parseInt(e.target.value) || 22 }))} />
                            </div>
                            <div>
                                <Label htmlFor="ssh_user">SSH User *</Label>
                                <Input id="ssh_user" value={form.ssh_user}
                                    onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))} />
                            </div>
                        </div>

                        <div>
                            <Label htmlFor="ssh_key">SSH Key</Label>
                            <select id="ssh_key" value={form.ssh_key_id}
                                onChange={e => setForm(f => ({ ...f, ssh_key_id: e.target.value }))}
                                className="w-full h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
                                <option value="">-- No key selected --</option>
                                {sshKeys.map(k => (
                                    <option key={k.id} value={k.id}>
                                        {k.name} ({k.fingerprint?.substring(0, 16)}...)
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <Label htmlFor="notes">Notes</Label>
                            <Input id="notes" value={form.notes}
                                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                        </div>

                        <div>
                            <Label htmlFor="portainer_url">Portainer URL</Label>
                            <Input id="portainer_url" value={form.portainer_url} placeholder="http://portainer:9000"
                                onChange={e => setForm(f => ({ ...f, portainer_url: e.target.value }))} />
                        </div>

                        <div className="flex gap-2 pt-4 border-t">
                            <Button onClick={save} disabled={saving}>
                                {saving ? 'Saving...' : 'Save Changes'}
                            </Button>
                            <Button variant="outline" onClick={test}>Test Connection</Button>
                            <Button variant="outline" onClick={detect}>Detect OS</Button>
                            <div className="flex-1" />
                            <Button variant="destructive" onClick={del}>Delete Server</Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </>
    );
}