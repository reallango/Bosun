'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { send, type Grant, type PermissionData, type PermissionDef, type PermissionGroup } from './data';

/** What the editor holds for one permission. */
interface Row {
  on: boolean;
  mode: 'all' | 'selected';
  servers: string[];
  groups: string[];
}

const EMPTY: Row = { on: false, mode: 'all', servers: [], groups: [] };

const RISK_STYLE: Record<PermissionDef['risk'], string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  high: 'bg-destructive/15 text-destructive',
};

/** Rows from a group's saved grants. */
function rowsFromGrants(grants: Grant[]): Record<string, Row> {
  const rows: Record<string, Row> = {};
  for (const g of grants) {
    const r = rows[g.permission] ?? { ...EMPTY, on: true, servers: [], groups: [] };
    if (g.scope.type === 'all') r.mode = 'all';
    else {
      if (r.mode !== 'all') r.mode = 'selected';   // an all-servers grant wins over narrower ones
      if (g.scope.type === 'server') r.servers.push(g.scope.id);
      else r.groups.push(g.scope.id);
    }
    rows[g.permission] = r;
  }
  // A permission granted for everything stays "all" even if narrower grants were also saved.
  for (const g of grants) if (g.scope.type === 'all') rows[g.permission].mode = 'all';
  return rows;
}

/** Grants from the editor's rows, or an error message naming the permission that is incomplete. */
function grantsFromRows(rows: Record<string, Row>, catalog: PermissionDef[]): { grants: Grant[] } | { error: string } {
  const grants: Grant[] = [];
  for (const def of catalog) {
    const r = rows[def.id];
    if (!r?.on) continue;
    if (def.scope === 'global' || r.mode === 'all') {
      grants.push({ permission: def.id, scope: { type: 'all' } });
      continue;
    }
    if (r.servers.length + r.groups.length === 0) return { error: `Choose at least one server or server group for "${def.label}", or switch it to all servers.` };
    for (const id of r.servers) grants.push({ permission: def.id, scope: { type: 'server', id } });
    for (const id of r.groups) grants.push({ permission: def.id, scope: { type: 'server_group', id } });
  }
  return { grants };
}

export function GroupEditorDialog({
  open, group, data, onOpenChange, onSaved,
}: { open: boolean; group: PermissionGroup | null; data: PermissionData; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [openScope, setOpenScope] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setRows(rowsFromGrants(group?.grants ?? []));
    setOpenScope(null);
    setError(null);
  }, [open, group]);

  // Catalog entries in order, under their headings.
  const sections = useMemo(() => {
    const out: Array<{ heading: string; items: PermissionDef[] }> = [];
    for (const def of data.catalog) {
      const existing = out.find(s => s.heading === def.group);
      if (existing) existing.items.push(def); else out.push({ heading: def.group, items: [def] });
    }
    return out;
  }, [data.catalog]);

  const labelOf = (id: string) => data.catalog.find(p => p.id === id)?.label ?? id;
  const patch = (id: string, change: Partial<Row>) => setRows(prev => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), ...change } }));
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const built = grantsFromRows(rows, data.catalog);
    if ('error' in built) { setError(built.error); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, grants: built.grants };
      if (group) await send(`/api/permission-groups/${group.id}`, 'PATCH', body);
      else await send('/api/permission-groups', 'POST', body);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = Object.values(rows).filter(r => r.on).length;

  return (
    <Dialog open={open} onOpenChange={o => { if (!saving) onOpenChange(o); }}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : 'New permission group'}</DialogTitle>
          <DialogDescription>
            A group adds permissions on top of a user&apos;s or API key&apos;s access level. Each one can apply to all servers or only some.
          </DialogDescription>
        </DialogHeader>
        <form id="group-form" onSubmit={submit} className="contents">
          <DialogBody className="space-y-5">
            {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="g-name">Name</Label>
                <Input id="g-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} required placeholder="e.g. Restart only" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-desc">Description</Label>
                <Input id="g-desc" value={description} onChange={e => setDescription(e.target.value)} maxLength={300} placeholder="Optional" />
              </div>
            </div>

            {sections.map(section => (
              <fieldset key={section.heading} className="space-y-1">
                <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.heading}</legend>
                {section.items.map(def => {
                  const r = rows[def.id] ?? EMPTY;
                  const scoped = def.scope === 'server' && r.on && r.mode === 'selected';
                  const chosen = r.servers.length + r.groups.length;
                  return (
                    <div key={def.id} className={cn('rounded-md border px-3 py-2', r.on ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-muted/40')}>
                      <div className="flex items-start gap-2">
                        <input id={`p-${def.id}`} type="checkbox" className="mt-1" checked={r.on} onChange={e => patch(def.id, { on: e.target.checked })} />
                        <div className="min-w-0 flex-1">
                          <label htmlFor={`p-${def.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                            {def.label}
                            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', RISK_STYLE[def.risk])}>{def.risk} risk</span>
                          </label>
                          <p className="text-xs text-muted-foreground">{def.description}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {def.defaultLevel === 'operator' ? 'Already included in Read + actions.' : 'Only included in Full access.'}
                            {(def.implies?.length ?? 0) > 0 && ` Also allows: ${def.implies!.map(labelOf).join(', ')}.`}
                          </p>
                        </div>
                        {r.on && def.scope === 'server' && (
                          <select
                            aria-label={`Where ${def.label} applies`}
                            className="form-select !h-8 !w-auto shrink-0 text-xs"
                            value={r.mode}
                            onChange={e => { patch(def.id, { mode: e.target.value as Row['mode'] }); if (e.target.value === 'selected') setOpenScope(def.id); }}
                          >
                            <option value="all">All servers</option>
                            <option value="selected">Only some…</option>
                          </select>
                        )}
                      </div>

                      {scoped && (
                        <div className="mt-2 pl-6">
                          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setOpenScope(openScope === def.id ? null : def.id)}>
                            {chosen === 0 ? 'Choose servers…' : `${r.groups.length} group${r.groups.length === 1 ? '' : 's'}, ${r.servers.length} server${r.servers.length === 1 ? '' : 's'} chosen`}
                            {openScope === def.id ? ' (hide)' : ' (edit)'}
                          </button>
                          {openScope === def.id && (
                            <div className="mt-1.5 grid gap-3 rounded-md border p-2 sm:grid-cols-2">
                              <div>
                                <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Server groups</div>
                                {data.serverGroups.length === 0 && <p className="text-xs text-muted-foreground">None yet (optional).</p>}
                                {data.serverGroups.map(sg => (
                                  <label key={sg.id} className="flex items-center gap-2 py-0.5 text-sm">
                                    <input type="checkbox" checked={r.groups.includes(sg.id)} onChange={() => patch(def.id, { groups: toggleIn(r.groups, sg.id) })} />
                                    <span className="truncate">{sg.name}</span>
                                    <span className="text-xs text-muted-foreground">{sg.server_ids.length}</span>
                                  </label>
                                ))}
                              </div>
                              <div>
                                <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Servers</div>
                                {data.servers.length === 0 && <p className="text-xs text-muted-foreground">No servers yet.</p>}
                                <div className="max-h-32 overflow-y-auto">
                                  {data.servers.map(s => (
                                    <label key={s.id} className="flex items-center gap-2 py-0.5 text-sm">
                                      <input type="checkbox" checked={r.servers.includes(s.id)} onChange={() => patch(def.id, { servers: toggleIn(r.servers, s.id) })} />
                                      <span className="truncate">{s.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </DialogBody>
          <DialogFooter>
            <span className="mr-auto self-center text-xs text-muted-foreground">{enabledCount} permission{enabledCount === 1 ? '' : 's'} selected</span>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : group ? 'Save' : 'Create group'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
