'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface ServerFormData {
  name: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_id: string;
  notes: string;
}

export default function ServerForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<ServerFormData>({
    name: '',
    hostname: '',
    ssh_port: 22,
    ssh_user: 'svc-bosun',
    ssh_key_id: '',
    notes: ''
  });

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