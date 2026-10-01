'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface ServerFormData {
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string;
  notes: string;
  platform: string;
}

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
}

export default function ServerForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sshKeys, setSSHKeys] = useState<SSHKey[]>([]);
  const [formData, setFormData] = useState<ServerFormData>({
    name: '',
    hostname: '',
    ssh_port: 22,
    ssh_user: 'svc-bosun',
    ssh_key_id: '',
    notes: '',
    platform: 'linux'
  });

  useEffect(() => {
    fetchWithAuth('/api/ssh-keys')
      .then(r => r.json())
      .then(j => { if (j.data) setSSHKeys(Array.isArray(j.data) ? j.data : j.data.ssh_keys || []); })
      .catch(() => setSSHKeys([]));
  }, []);

  const handleChange = (field: keyof ServerFormData, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
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
    <Card>
      <CardHeader>
        <CardTitle>Add Server</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hostname">Hostname / IP *</Label>
            <Input
              id="hostname"
              value={formData.hostname}
              onChange={(e) => handleChange('hostname', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssh_port">SSH Port</Label>
            <Input
              id="ssh_port"
              type="number"
              value={formData.ssh_port}
              onChange={(e) => handleChange('ssh_port', parseInt(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssh_user">SSH User *</Label>
            <Input
              id="ssh_user"
              value={formData.ssh_user}
              onChange={(e) => handleChange('ssh_user', e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssh_key_id">SSH Key</Label>
            <select
              id="ssh_key_id"
              value={formData.ssh_key_id}
              onChange={(e) => handleChange('ssh_key_id', e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            >
              <option value="">-- No key selected --</option>
              {sshKeys.map(k => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.fingerprint?.substring(0, 16)}...)
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">Required for widgets, Detect OS, and the terminal.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="platform">Platform</Label>
            <select
              id="platform"
              value={formData.platform}
              onChange={(e) => handleChange('platform', e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
            >
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Input
              id="notes"
              value={formData.notes}
              onChange={(e) => handleChange('notes', e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating...' : 'Create Server'}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}