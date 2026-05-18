'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
}

interface Server {
  id: string;
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string | null;
  notes: string;
}

interface EditServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  server: Server | null;
  onSave: () => void;
}

export function EditServerModal({ isOpen, onClose, server, onSave }: EditServerModalProps) {
  const [form, setForm] = useState({
    name: '', hostname: '', ssh_port: 22, ssh_user: '', ssh_key_id: '', notes: '',
  });
  const [sshKeys, setSSHKeys] = useState<SSHKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (server && isOpen) {
      setForm({
        name: server.name || '',
        hostname: server.hostname || '',
        ssh_port: server.ssh_port || 22,
        ssh_user: server.ssh_user || '',
        ssh_key_id: server.ssh_key_id || '',
        notes: server.notes || '',
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
      setForm({ name: '', hostname: '', ssh_port: 22, ssh_user: '', ssh_key_id: '', notes: '' });
      setError('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

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
      alert(d.data?.success
        ? `✅ Connection OK! Latency: ${d.data.latencyMs}ms`
        : `❌ Failed: ${d.error?.message}`);
    } catch {
      alert('❌ Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">Edit Server</h3>
        
        {error && (
          <div className="text-red-500 text-sm p-2 bg-red-50 dark:bg-red-950 rounded mb-4">{error}</div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Hostname / IP *</label>
            <input
              type="text"
              value={form.hostname}
              onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">SSH Port</label>
              <input
                type="number"
                value={form.ssh_port}
                onChange={e => setForm(f => ({ ...f, ssh_port: parseInt(e.target.value) || 22 }))}
                className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">SSH User *</label>
              <input
                type="text"
                value={form.ssh_user}
                onChange={e => setForm(f => ({ ...f, ssh_user: e.target.value }))}
                className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">SSH Key</label>
            <select
              value={form.ssh_key_id}
              onChange={e => setForm(f => ({ ...f, ssh_key_id: e.target.value }))}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            >
              <option value="">-- No key selected --</option>
              {sshKeys.map(k => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.fingerprint?.substring(0, 16)}...)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Notes</label>
            <input
              type="text"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={testConnection}
            disabled={loading}
            className="flex-1 px-4 py-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            {loading ? 'Testing...' : 'Test'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}