'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
}

interface Server {
  id: string;
  name: string;
  hostname?: string;
  host?: string;
  ssh_port: number;
  ssh_user: string | null;
  ssh_key_id: string | null;
  notes?: string;
  platform?: string;
}

interface EditServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  server: Server | null;
  onSave: () => void;
}

const EMPTY_FORM = { name: '', hostname: '', ssh_port: 22, ssh_user: '', ssh_key_id: '', notes: '', platform: 'linux' };

export function EditServerModal({ isOpen, onClose, server, onSave }: EditServerModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [sshKeys, setSSHKeys] = useState<SSHKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    if (server && isOpen) {
      setForm({
        name: server.name || '',
        hostname: server.hostname || server.host || '',
        ssh_port: server.ssh_port || 22,
        ssh_user: server.ssh_user || '',
        ssh_key_id: server.ssh_key_id || '',
        notes: server.notes || '',
        platform: server.platform || 'linux',
      });
      setError('');

      fetchWithAuth('/api/ssh-keys')
        .then(r => r.json())
        .then(j => { if (j.data) setSSHKeys(Array.isArray(j.data) ? j.data : j.data.ssh_keys || []); })
        .catch(() => setSSHKeys([]));
    }
  }, [server, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setForm(EMPTY_FORM);
      setError('');
    }
  }, [isOpen]);

  const save = async () => {
    if (!server) return;
    setSaving(true);
    setError('');
    try {
      const r = await fetchWithAuth(`/api/servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const d = await r.json();
        setError(d.error?.message || 'Failed to save');
        return;
      }
      toast('Server saved', { variant: 'success' });
      onSave();
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!server) return;
    setLoading(true);
    try {
      const r = await fetchWithAuth(`/api/servers/${server.id}/test`, { method: 'POST' });
      const d = await r.json();
      if (d.data?.success) toast('Connection OK', { variant: 'success', description: `Latency: ${d.data.latencyMs}ms` });
      else toast('Connection failed', { variant: 'error', description: d.error?.message });
    } catch {
      toast('Connection failed', { variant: 'error', description: 'Network error' });
    } finally {
      setLoading(false);
    }
  };

  const field = (key: keyof typeof EMPTY_FORM) => `edit-server-${key}`;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Edit server</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <form
            id="edit-server-form"
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault();
              save();
            }}
          >
            {error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={field('name')}>Name *</Label>
              <Input id={field('name')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={field('hostname')}>Hostname / IP *</Label>
              <Input
                id={field('hostname')}
                value={form.hostname}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 xs:grid-cols-[8rem_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor={field('ssh_port')}>SSH port</Label>
                <Input
                  id={field('ssh_port')}
                  type="number"
                  inputMode="numeric"
                  value={form.ssh_port}
                  onChange={e => setForm(f => ({ ...f, ssh_port: parseInt(e.target.value) || 22 }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={field('ssh_user')}>SSH user *</Label>
                <Input
                  id={field('ssh_user')}
                  value={form.ssh_user}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={field('platform')}>Platform</Label>
                <select
                  id={field('platform')}
                  value={form.platform}
                  onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                  className="form-select"
                >
                  <option value="linux">Linux</option>
                  <option value="windows">Windows</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={field('ssh_key_id')}>SSH key</Label>
                <select
                  id={field('ssh_key_id')}
                  value={form.ssh_key_id}
                  onChange={e => setForm(f => ({ ...f, ssh_key_id: e.target.value }))}
                  className="form-select"
                >
                  <option value="">-- No key selected --</option>
                  {sshKeys.map(k => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.fingerprint?.substring(0, 16)}...)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={field('notes')}>Notes</Label>
              <Input id={field('notes')} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" size="lg" onClick={testConnection} disabled={loading}>
            {loading ? 'Testing…' : 'Test connection'}
          </Button>
          <Button size="lg" type="submit" form="edit-server-form" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
