'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { DASHBOARD_NAME_MAX, notifyDashboardsChanged } from '@/lib/dashboards/events';
import type { Dashboard } from '@/types/dashboard';

interface DashboardNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set to rename that dashboard; omit to create a new one. */
  dashboard?: { id: string; name: string };
  onSaved?: (dashboard: Pick<Dashboard, 'id' | 'name'>) => void;
}

/** Create a dashboard, or change the display name of an existing one. */
export function DashboardNameDialog({ open, onOpenChange, dashboard, onSaved }: DashboardNameDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(dashboard?.name ?? '');
      setError('');
      setSaving(false);
    }
  }, [open, dashboard?.name]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetchWithAuth(dashboard ? `/api/dashboards/${dashboard.id}` : '/api/dashboards', {
        method: dashboard ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
      notifyDashboardsChanged();
      onSaved?.({ id: json?.data?.dashboard?.id ?? dashboard?.id, name: json?.data?.dashboard?.name ?? trimmed });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the dashboard');
      setSaving(false);
    }
  };

  const unchanged = !!dashboard && name.trim() === dashboard.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{dashboard ? 'Rename dashboard' : 'New dashboard'}</DialogTitle>
            <DialogDescription>
              {dashboard ? 'Change the name shown in the sidebar and page header.' : 'It appears under Home. Add widgets from any server once it exists.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1.5">
            <Label htmlFor="dashboard-name">Name</Label>
            <Input
              id="dashboard-name"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={DASHBOARD_NAME_MAX}
              autoFocus
              required
              autoComplete="off"
            />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={saving || !name.trim() || unchanged}>
              {saving ? 'Saving…' : dashboard ? 'Rename' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
