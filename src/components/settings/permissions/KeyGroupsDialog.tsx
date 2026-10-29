'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { GroupPicker } from './GroupPicker';
import { send, type PermissionGroup } from './data';

/** Change which permission groups an API key holds. */
export function KeyGroupsDialog({
  keyId, keyName, selected, onOpenChange, onSaved,
}: { keyId: string | null; keyName: string; selected: string[]; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const open = keyId !== null;
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setIds(selected);
    setError(null);
    fetchWithAuth('/api/permission-groups').then(r => r.json()).then(j => setGroups(j.data?.groups ?? [])).catch(() => setGroups([]));
  }, [open, selected]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await send(`/api/api-keys/${keyId}/groups`, 'PUT', { group_ids: ids });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!saving) onOpenChange(o); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Permission groups for {keyName}</DialogTitle>
          <DialogDescription>Groups add individual permissions on top of the key&apos;s access level. Changes apply within about 30 seconds.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
          <GroupPicker groups={groups} selected={ids} onChange={setIds} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
