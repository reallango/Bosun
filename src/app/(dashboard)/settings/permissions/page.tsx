'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useToast } from '@/components/ui/toast';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';
import { AdminOnlyNotice } from '@/components/settings/access-ui';
import { GroupEditorDialog } from '@/components/settings/permissions/GroupEditorDialog';
import { ServerGroupDialog } from '@/components/settings/permissions/ServerGroupDialog';
import { scopeLabel, send, usePermissionData, type PermissionGroup, type ServerGroup } from '@/components/settings/permissions/data';
import { ACCESS_LEVELS, ROLES, hasRole } from '@/lib/auth/levels';
import { useAuth } from '@/hooks/useAuth';

export default function PermissionsPage() {
  const { user: me } = useAuth();
  const isAdmin = hasRole(me?.role, 'admin');
  const { toast } = useToast();
  const { data, loading, error, reload } = usePermissionData();
  const [editing, setEditing] = useState<PermissionGroup | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [editingServerGroup, setEditingServerGroup] = useState<ServerGroup | null>(null);
  const [serverGroupOpen, setServerGroupOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ kind: 'group'; item: PermissionGroup } | { kind: 'server'; item: ServerGroup } | null>(null);

  if (!isAdmin) {
    return (
      <>
        <Header title="Permissions" />
        <div className="page max-w-6xl"><AdminOnlyNotice /></div>
      </>
    );
  }

  const openGroup = (g: PermissionGroup | null) => { setEditing(g); setGroupOpen(true); };
  const openServerGroup = (g: ServerGroup | null) => { setEditingServerGroup(g); setServerGroupOpen(true); };

  const summary = (g: PermissionGroup) => {
    if (!data) return '';
    const label = (id: string) => data.catalog.find(p => p.id === id)?.label ?? id;
    return g.grants.map(x => `${label(x.permission)} (${scopeLabel(x, data.servers, data.serverGroups)})`).join('\n');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const url = deleting.kind === 'group' ? `/api/permission-groups/${deleting.item.id}` : `/api/server-groups/${deleting.item.id}`;
    await send(url, 'DELETE');
    toast(`Deleted ${deleting.item.name}`, { variant: 'success' });
    reload();
  };

  return (
    <>
      <Header title="Permissions" />
      <div className="page max-w-6xl space-y-6">
        <Card>
          <CardContent className="space-y-2 text-sm">
            <p className="font-medium">How access works</p>
            <p className="text-muted-foreground">
              Everyone has an <strong>access level</strong>, set on the user or API key:{' '}
              {ROLES.map((r, i) => (
                <span key={r}>{i > 0 && ', '}<strong>{ACCESS_LEVELS[r].label}</strong></span>
              ))}.
              The level decides what they can do by default, exactly as before.
              A <strong>permission group</strong> adds individual actions on top of it, for all servers or only some.
              For example, a Read only API key in a group that holds &quot;Restart a server&quot; for one machine can look at everything and restart just that machine.
            </p>
          </CardContent>
        </Card>

        {loading ? <LoadingSpinner /> : error || !data ? (
          <ErrorState message={error || 'Failed to load'} onRetry={reload} />
        ) : (
          <>
            <section className="space-y-3" aria-labelledby="groups-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="groups-heading" className="text-base font-semibold">Permission groups</h2>
                <Button size="lg" onClick={() => openGroup(null)}><Plus />New group</Button>
              </div>
              <Card className="py-0">
                <CardContent className="px-0">
                  {data.groups.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">No permission groups yet.</div>
                  ) : (
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="px-4">Group</TableHead>
                          <TableHead>Permissions</TableHead>
                          <TableHead>Used by</TableHead>
                          <TableHead className="px-4 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.groups.map(g => (
                          <TableRow key={g.id}>
                            <TableCell className="max-w-[18rem] px-4">
                              <div className="truncate font-medium">{g.name}</div>
                              {g.description && <div className="truncate text-xs text-muted-foreground">{g.description}</div>}
                            </TableCell>
                            <TableCell className="text-muted-foreground" title={summary(g)}>
                              {g.grants.length === 0 ? 'None' : `${g.grants.length} grant${g.grants.length === 1 ? '' : 's'}`}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              <span className="inline-flex items-center gap-1"><Users className="size-3.5" aria-hidden />{g.user_count} user{g.user_count === 1 ? '' : 's'}, {g.api_key_count} API key{g.api_key_count === 1 ? '' : 's'}</span>
                            </TableCell>
                            <TableCell className="px-4">
                              <div className="flex justify-end gap-0.5">
                                <Button variant="ghost" size="icon-lg" onClick={() => openGroup(g)} aria-label={`Edit ${g.name}`} title="Edit"><Pencil /></Button>
                                <Button variant="ghost" size="icon-lg" onClick={() => setDeleting({ kind: 'group', item: g })} aria-label={`Delete ${g.name}`} title="Delete"><Trash2 className="text-destructive" /></Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
              <p className="text-xs text-muted-foreground">Assign groups to a user under Settings → Users, and to an API key under Settings → API Access.</p>
            </section>

            <section className="space-y-3" aria-labelledby="server-groups-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="server-groups-heading" className="text-base font-semibold">Server groups <span className="text-xs font-normal text-muted-foreground">(optional)</span></h2>
                <Button size="lg" variant="outline" onClick={() => openServerGroup(null)}><Plus />New server group</Button>
              </div>
              <Card className="py-0">
                <CardContent className="px-0">
                  {data.serverGroups.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      No server groups. You can always grant a permission for one server without a group.
                    </div>
                  ) : (
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="px-4">Group</TableHead>
                          <TableHead>Servers</TableHead>
                          <TableHead className="px-4 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.serverGroups.map(g => (
                          <TableRow key={g.id}>
                            <TableCell className="max-w-[18rem] px-4">
                              <div className="truncate font-medium">{g.name}</div>
                              {g.description && <div className="truncate text-xs text-muted-foreground">{g.description}</div>}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {g.server_ids.length === 0 ? 'No servers' : g.server_ids.map(id => data.servers.find(s => s.id === id)?.name ?? '?').join(', ')}
                            </TableCell>
                            <TableCell className="px-4">
                              <div className="flex justify-end gap-0.5">
                                <Button variant="ghost" size="icon-lg" onClick={() => openServerGroup(g)} aria-label={`Edit ${g.name}`} title="Edit"><Pencil /></Button>
                                <Button variant="ghost" size="icon-lg" onClick={() => setDeleting({ kind: 'server', item: g })} aria-label={`Delete ${g.name}`} title="Delete"><Trash2 className="text-destructive" /></Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>

            <GroupEditorDialog open={groupOpen} group={editing} data={data} onOpenChange={setGroupOpen} onSaved={reload} />
            <ServerGroupDialog open={serverGroupOpen} group={editingServerGroup} servers={data.servers} onOpenChange={setServerGroupOpen} onSaved={reload} />
          </>
        )}

        <ConfirmActionDialog
          open={!!deleting}
          onOpenChange={o => { if (!o) setDeleting(null); }}
          title={deleting ? `Delete ${deleting.item.name}?` : ''}
          description={deleting?.kind === 'group'
            ? `The ${deleting.item.user_count} user(s) and ${deleting.item.api_key_count} API key(s) that hold this group lose its permissions straight away.`
            : 'Permissions that were granted for this group of servers are removed with it. The servers themselves are not affected.'}
          confirmLabel="Delete"
          destructive
          onConfirm={confirmDelete}
        />
      </div>
    </>
  );
}
