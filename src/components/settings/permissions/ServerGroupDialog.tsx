'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { send, type ServerGroup, type ServerLite } from './data';

/** Create or edit a server group: a named set of servers that a permission can be granted to at once. */
export function ServerGroupDialog({
  open, group, servers, onOpenChange, onSaved,
}: { open: boolean; group: ServerGroup | null; servers: ServerLite[]; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setMembers(group?.server_ids ?? []);
    setError(null);
  }, [open, group]);

  const toggle = (id: string) => setMembers(m => (m.includes(id) ? m.filter(x => x !== id) : [...m, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, server_ids: members };
      if (group) await send(`/api/server-groups/${group.id}`, 'PATCH', body);
      else await send('/api/server-groups', 'POST', body);
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
          <DialogTitle>{group ? `Edit ${group.name}` : 'New server group'}</DialogTitle>
          <DialogDescription>A server can be in several groups. Groups are optional: a permission can also be granted for a single server.</DialogDescription>
        </DialogHeader>
        <form id="server-group-form" onSubmit={submit} className="contents">
          <DialogBody className="space-y-4">
            {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
            <div className="space-y-1.5">
              <Label htmlFor="sg-name">Name</Label>
              <Input id="sg-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} required placeholder="e.g. Lab machines" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sg-desc">Description</Label>
              <Input id="sg-desc" value={description} onChange={e => setDescription(e.target.value)} maxLength={300} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label>Servers ({members.length} selected)</Label>
              {servers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No servers yet.</p>
              ) : (
                <ul className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border p-2">
                  {servers.map(s => (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                        <input type="checkbox" checked={members.includes(s.id)} onChange={() => toggle(s.id)} />
                        <span className="truncate">{s.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : group ? 'Save' : 'Create group'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
