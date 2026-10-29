'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Mail, Pencil, Plus, Power, Trash2, UserRound } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { useToast } from '@/components/ui/toast';
import { ConfirmActionDialog, apiAction } from '@/components/widgets/shared/ConfirmActionDialog';
import { AdminOnlyNotice, LevelBadge, LevelSelect, When } from '@/components/settings/access-ui';
import { useAuth } from '@/hooks/useAuth';
import { GroupPicker } from '@/components/settings/permissions/GroupPicker';
import type { PermissionGroup } from '@/components/settings/permissions/data';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { hasRole } from '@/lib/auth/levels';
import { cn } from '@/lib/utils';

interface User {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
  disabled: boolean;
  mfa_method: string;
  last_login: string | null;
  created_at: string | null;
  group_ids?: string[];
}

const MFA_LABEL: Record<string, string> = { none: 'Off', totp: 'Authenticator app', email: 'Email code' };

type Pending =
  | { kind: 'delete'; user: User }
  | { kind: 'toggle'; user: User }
  | { kind: 'reset-email'; user: User };

function MfaStatus({ method }: { method: string }) {
  const on = method && method !== 'none';
  return <span className={cn('text-xs', on ? 'text-success' : 'text-muted-foreground')}>{MFA_LABEL[method] ?? method}</span>;
}

function StatusPill({ disabled }: { disabled: boolean }) {
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs', disabled ? 'bg-destructive/15 text-destructive' : 'bg-green-500/15 text-green-700 dark:text-green-400')}>
      {disabled ? 'Disabled' : 'Active'}
    </span>
  );
}

/** Create or edit a user. `user` null = create. */
function UserDialog({ open, user, onOpenChange, onSaved }: { open: boolean; user: User | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [form, setForm] = useState({ username: '', display_name: '', email: '', role: 'viewer', password: '' });
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Permission groups the user can be put in (loaded when the dialog opens).
  useEffect(() => {
    if (!open) return;
    fetchWithAuth('/api/permission-groups')
      .then(r => r.json())
      .then(j => setGroups(j.data?.groups ?? []))
      .catch(() => setGroups([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(user
      ? { username: user.username, display_name: user.display_name ?? '', email: user.email ?? '', role: user.role, password: '' }
      : { username: '', display_name: '', email: '', role: 'viewer', password: '' });
    setGroupIds(user?.group_ids ?? []);
  }, [open, user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (user) {
        const body: Record<string, unknown> = { display_name: form.display_name, email: form.email };
        if (form.role !== user.role) body.role = form.role;
        await apiAction(fetchWithAuth, `/api/users/${user.id}`, 'PATCH', body);
        await apiAction(fetchWithAuth, `/api/users/${user.id}/groups`, 'PUT', { group_ids: groupIds });
      } else {
        const created = await apiAction(fetchWithAuth, '/api/users', 'POST', form) as { user?: { id?: string } };
        if (groupIds.length && created?.user?.id) await apiAction(fetchWithAuth, `/api/users/${created.user.id}/groups`, 'PUT', { group_ids: groupIds });
      }
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
          <DialogTitle>{user ? `Edit ${user.username}` : 'New user'}</DialogTitle>
          <DialogDescription>{user ? 'Name, email and access level.' : 'The user signs in with this username and password.'}</DialogDescription>
        </DialogHeader>
        <form id="user-form" onSubmit={submit} className="contents">
          <DialogBody className="space-y-4">
            {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
            {!user && (
              <div className="space-y-1.5">
                <Label htmlFor="u-username">Username</Label>
                <Input id="u-username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" required />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="u-display">Display name</Label>
              <Input id="u-display" value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-email">Email</Label>
              <Input id="u-email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="Optional; used for password reset and email codes" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-role">Access level</Label>
              <LevelSelect id="u-role" value={form.role} onChange={role => setForm({ ...form, role })} />
            </div>
            <div className="space-y-1.5">
              <Label>Permission groups</Label>
              <GroupPicker groups={groups} selected={groupIds} onChange={setGroupIds} />
              <p className="text-xs text-muted-foreground">Groups add individual permissions on top of the access level, for all servers or only some.</p>
            </div>
            {!user && (
              <div className="space-y-1.5">
                <Label htmlFor="u-password">Password</Label>
                <Input id="u-password" type="password" autoComplete="new-password" minLength={8} value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })} required />
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : user ? 'Save' : 'Create user'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ user, onOpenChange, onSaved }: { user: User | null; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPassword(''); setConfirm(''); setError(null); }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (password !== confirm) { setError('The passwords do not match'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiAction(fetchWithAuth, `/api/users/${user.id}`, 'PATCH', { password });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={o => { if (!saving) onOpenChange(o); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Set new password</DialogTitle>
          <DialogDescription>For {user?.username}. All of their sessions are signed out.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents">
          <DialogBody className="space-y-4">
            {error && <div role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
            <div className="space-y-1.5">
              <Label htmlFor="pw-new">New password</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">Repeat password</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} required />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Set password'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RowActions({ user, self, onEdit, onPassword, onPending }: {
  user: User; self: boolean; onEdit: () => void; onPassword: () => void; onPending: (p: Pending) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-0.5">
      <Button variant="ghost" size="icon-lg" onClick={onEdit} aria-label={`Edit ${user.username}`} title="Edit"><Pencil /></Button>
      <Button variant="ghost" size="icon-lg" onClick={onPassword} aria-label={`Set password for ${user.username}`} title="Set new password"><KeyRound /></Button>
      {user.email && (
        <Button variant="ghost" size="icon-lg" onClick={() => onPending({ kind: 'reset-email', user })}
          aria-label={`Send password reset email to ${user.username}`} title="Send password reset email"><Mail /></Button>
      )}
      {!self && (
        <>
          <Button variant="ghost" size="icon-lg" onClick={() => onPending({ kind: 'toggle', user })}
            aria-label={`${user.disabled ? 'Enable' : 'Disable'} ${user.username}`} title={user.disabled ? 'Enable' : 'Disable'}>
            <Power className={user.disabled ? 'text-success' : undefined} />
          </Button>
          <Button variant="ghost" size="icon-lg" onClick={() => onPending({ kind: 'delete', user })} aria-label={`Delete ${user.username}`} title="Delete">
            <Trash2 className="text-destructive" />
          </Button>
        </>
      )}
    </div>
  );
}

export default function UsersPage() {
  const { user: me } = useAuth();
  const isAdmin = hasRole(me?.role, 'admin');
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pwUser, setPwUser] = useState<User | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await readJson<{ data?: { users?: User[] }; error?: { message?: string } }>(await fetchWithAuth('/api/users'));
      if (json.error) setError(json.error.message || 'Failed to load users');
      else setUsers(json.data?.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
    else if (me) setLoading(false);
  }, [isAdmin, me, load]);

  const runPending = async () => {
    if (!pending) return;
    const u = pending.user;
    if (pending.kind === 'delete') {
      await apiAction(fetchWithAuth, `/api/users/${u.id}`, 'DELETE');
      toast(`Deleted ${u.username}`, { variant: 'success' });
    } else if (pending.kind === 'toggle') {
      await apiAction(fetchWithAuth, `/api/users/${u.id}`, 'PATCH', { disabled: !u.disabled });
      toast(`${u.disabled ? 'Enabled' : 'Disabled'} ${u.username}`, { variant: 'success' });
    } else {
      await apiAction(fetchWithAuth, '/api/auth/forgot', 'POST', { username: u.username });
      toast(`Password reset email sent to ${u.username}`, { variant: 'success' });
    }
    load();
  };

  const confirmProps = (() => {
    if (!pending) return { title: '', description: '', confirmLabel: '', destructive: false };
    const u = pending.user;
    if (pending.kind === 'delete') {
      return {
        title: `Delete ${u.username}?`,
        description: 'The account and its sessions are removed. Audit log entries are kept. This cannot be undone.',
        confirmLabel: 'Delete user', destructive: true, requireText: u.username,
      };
    }
    if (pending.kind === 'toggle') {
      return u.disabled
        ? { title: `Enable ${u.username}?`, description: 'They can sign in again.', confirmLabel: 'Enable', destructive: false }
        : { title: `Disable ${u.username}?`, description: 'They are signed out and cannot sign in until enabled again.', confirmLabel: 'Disable', destructive: true };
    }
    return {
      title: `Send a password reset email to ${u.username}?`,
      description: <>A reset link is emailed to <span className="font-medium">{u.email}</span>. Email must be configured under Settings.</>,
      confirmLabel: 'Send email', destructive: false,
    };
  })();

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (u: User) => { setEditing(u); setDialogOpen(true); };

  return (
    <>
      <Header title="Users" />
      <div className="page max-w-6xl space-y-4">
        {!loading && !isAdmin ? (
          <AdminOnlyNotice />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Accounts that can sign in to Bosun. Levels: Read only, Read + actions, Full access.
              </p>
              <Button size="lg" onClick={openCreate}><Plus />Add user</Button>
            </div>

            <Card className="py-0">
              <CardContent className="px-0">
                {loading ? (
                  <LoadingSpinner />
                ) : error ? (
                  <ErrorState message={error} onRetry={load} />
                ) : users.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No users</div>
                ) : (
                  <>
                    <ul className="divide-y md:hidden">
                      {users.map(u => (
                        <li key={u.id} className="space-y-2 px-4 py-3 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                              <div className="min-w-0">
                                <div className="truncate font-medium">{u.username}{u.id === me?.id && <span className="text-muted-foreground"> (you)</span>}</div>
                                {(u.display_name || u.email) && <div className="truncate text-xs text-muted-foreground">{[u.display_name, u.email].filter(Boolean).join(' · ')}</div>}
                              </div>
                            </div>
                            <StatusPill disabled={u.disabled} />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <LevelBadge role={u.role} />
                            {!!u.group_ids?.length && <span>+ {u.group_ids.length} group{u.group_ids.length === 1 ? '' : 's'}</span>}
                            <span>MFA: <MfaStatus method={u.mfa_method} /></span>
                            <span>Last login: <When value={u.last_login} empty="never" /></span>
                          </div>
                          <RowActions user={u} self={u.id === me?.id} onEdit={() => openEdit(u)} onPassword={() => setPwUser(u)} onPending={setPending} />
                        </li>
                      ))}
                    </ul>
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader className="bg-muted/50">
                          <TableRow>
                            <TableHead className="px-4">User</TableHead>
                            <TableHead>Access level</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>MFA</TableHead>
                            <TableHead>Last login</TableHead>
                            <TableHead className="px-4 text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {users.map(u => (
                            <TableRow key={u.id}>
                              <TableCell className="max-w-[18rem] px-4">
                                <div className="truncate font-medium">{u.username}{u.id === me?.id && <span className="text-muted-foreground"> (you)</span>}</div>
                                {(u.display_name || u.email) && <div className="truncate text-xs text-muted-foreground">{[u.display_name, u.email].filter(Boolean).join(' · ')}</div>}
                              </TableCell>
                              <TableCell>
                                <LevelBadge role={u.role} />
                                {!!u.group_ids?.length && <span className="ml-1.5 text-xs text-muted-foreground">+ {u.group_ids.length} group{u.group_ids.length === 1 ? '' : 's'}</span>}
                              </TableCell>
                              <TableCell><StatusPill disabled={u.disabled} /></TableCell>
                              <TableCell><MfaStatus method={u.mfa_method} /></TableCell>
                              <TableCell className="text-muted-foreground"><When value={u.last_login} empty="never" /></TableCell>
                              <TableCell className="px-4">
                                <RowActions user={u} self={u.id === me?.id} onEdit={() => openEdit(u)} onPassword={() => setPwUser(u)} onPending={setPending} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <UserDialog open={dialogOpen} user={editing} onOpenChange={setDialogOpen}
        onSaved={() => { toast(editing ? 'User updated' : 'User created', { variant: 'success' }); load(); }} />
      <PasswordDialog user={pwUser} onOpenChange={o => { if (!o) setPwUser(null); }}
        onSaved={() => toast('Password changed; the user was signed out', { variant: 'success' })} />
      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        {...confirmProps}
        onConfirm={runPending}
      />
    </>
  );
}
