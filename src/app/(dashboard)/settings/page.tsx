'use client';

import Header from '@/components/layout/Header';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AppSettingsCard from '@/components/settings/AppSettingsCard';

export default function SettingsPage() {
  const { user } = useAuth();

  const fields = [
    { id: 'app-name', label: 'Application name', value: 'Bosun' },
    { id: 'current-user', label: 'Current user', value: user?.username || '' },
    { id: 'user-role', label: 'Role', value: user?.role || '' },
  ];

  return (
    <>
      <Header title="Settings" />
      <div className="page max-w-4xl space-y-4 sm:space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {fields.map(f => (
                <div key={f.id} className="space-y-1.5">
                  <Label htmlFor={f.id}>{f.label}</Label>
                  <Input id={f.id} value={f.value} readOnly className="bg-muted/50" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <AppSettingsCard />
      </div>
    </>
  );
}
