'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export default function NewServerPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setupMethod, setSetupMethod] = useState<'existing' | 'auto'>('existing');
  
  // Auto-provision state
  const [provisioning, setProvisioning] = useState(false);
  const [provisionSteps, setProvisionSteps] = useState<string[]>([]);
  const [provisionError, setProvisionError] = useState('');
  const [provisionData, setProvisionData] = useState<any>(null);

  const handleProvision = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProvisioning(true);
    setProvisionError('');
    setProvisionSteps([]);
    setProvisionData(null);

    const formData = new FormData(e.currentTarget);
    const hostname = formData.get('hostname') as string;
    const port = parseInt(formData.get('ssh_port') as string) || 22;
    const admin_username = formData.get('admin_username') as string;
    const admin_password = formData.get('admin_password') as string;
    const service_account = formData.get('service_account') as string || 'bosun';

    try {
      const res = await fetch('/api/servers/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname, port, admin_username, admin_password, service_account })
      });
      const data = await res.json();
      
      if (!res.ok) {
        setProvisionError(data.error?.message || 'Provisioning failed');
        return;
      }
      
      setProvisionSteps(data.data?.steps || []);
      setProvisionData(data.data);
    } catch (err) {
      setProvisionError(String(err));
    } finally {
      setProvisioning(false);
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
          notes: formData.get('notes')
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
      <div className="p-8">
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Add Server</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Setup Method Tabs */}
            <div className="flex gap-2 mb-6">
              <Button
                type="button"
                variant={setupMethod === 'existing' ? 'default' : 'outline'}
                onClick={() => setSetupMethod('existing')}
              >
                I have existing SSH credentials
              </Button>
              <Button
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
                  <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">
                    {provisionError || error}
                  </div>
                )}
                
                {provisionData ? (
                  // Show results after provisioning
                  <div className="space-y-4">
                    <div className="p-4 bg-green-50 border border-green-200 rounded-md">
                      <div className="font-medium text-green-700 mb-2">Provisioning Successful!</div>
                      <div className="text-sm space-y-1">
                        {provisionSteps.map((step, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-green-600">✓</span>
                            <span className="text-green-600">{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="text-sm text-gray-600">
                      <p>Service account: <strong>{provisionData.service_account}</strong></p>
                      <p>SSH Key: <strong>{provisionData.ssh_key_name}</strong></p>
                    </div>
                    <Button
                      type="button"
                      onClick={() => {
                        setSetupMethod('existing');
                        // Pre-fill form with provisioned values
                        const hostname = (document.getElementById('hostname') as HTMLInputElement).value;
                        (document.getElementById('ssh_user') as HTMLInputElement).value = provisionData.service_account;
                      }}
                      variant="outline"
                    >
                      Continue to Save
                    </Button>
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
                      <Label htmlFor="admin_username">Admin Username *</Label>
                      <Input id="admin_username" name="admin_username" placeholder="root" required />
                      <p className="text-xs text-gray-500">SSH username with sudo access</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="admin_password">Admin Password *</Label>
                      <Input id="admin_password" name="admin_password" type="password" required />
                      <p className="text-xs text-gray-500">Password for admin user (used once, not stored)</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="service_account">Service Account Name</Label>
                      <Input id="service_account" name="service_account" defaultValue="bosun" />
                    </div>
                    <div className="flex gap-2">
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
                  <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">
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
                  <Label htmlFor="notes">Notes</Label>
                  <Input id="notes" name="notes" />
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
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}