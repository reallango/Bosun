'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { DeleteConfirmDialog } from '@/components/dialogs/DeleteConfirmDialog';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
  key_type: string;
  created_at: string;
  servers?: string[];
}

interface GeneratedKey {
  private_key: string;
  public_key: string;
  fingerprint: string;
}

function KeyBlock({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, { variant: 'success' });
    } catch {
      toast('Copy failed', { variant: 'error', description: 'Select the text and copy it manually.' });
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
          <Copy />
          Copy
        </Button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[11px] leading-snug">{value}</pre>
    </div>
  );
}

export default function SSHKeysPage() {
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [toDelete, setToDelete] = useState<SSHKey | null>(null);
  const { toast } = useToast();

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/ssh-keys');
      const data = await res.json();
      if (data.data) setKeys(Array.isArray(data.data) ? data.data : data.data.ssh_keys || []);
    } catch (err) {
      console.error('Failed to fetch keys:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetchWithAuth('/api/ssh-keys/generate', { method: 'POST' });
      const data = await res.json();
      if (data.data) {
        setGenerated(data.data);
        fetchKeys();
      } else {
        toast('Failed to generate key', { variant: 'error', description: data.error?.message });
      }
    } catch (err) {
      toast('Failed to generate key', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (key: SSHKey) => {
    try {
      const res = await fetchWithAuth(`/api/ssh-keys/${key.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast('SSH key deleted', { variant: 'success' });
        fetchKeys();
      } else {
        const json = await res.json().catch(() => null);
        toast('Failed to delete key', { variant: 'error', description: json?.error?.message });
      }
    } catch (err) {
      toast('Failed to delete key', { variant: 'error', description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <>
      <Header title="SSH Keys" />
      <div className="page max-w-6xl">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>SSH keys</CardTitle>
            <Button size="lg" onClick={handleGenerate} disabled={generating}>
              <Plus />
              {generating ? 'Generating…' : 'Generate new key'}
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <LoadingSpinner />
            ) : keys.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No SSH keys. Generate one to get started.</p>
            ) : (
              <>
                <ul className="divide-y md:hidden">
                  {keys.map(key => (
                    <li key={key.id} className="flex items-start gap-3 py-3">
                      <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{key.name}</span>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{key.key_type}</span>
                        </div>
                        <div className="break-all font-mono text-[11px] text-muted-foreground">{key.fingerprint}</div>
                        <div className="text-xs text-muted-foreground">
                          {key.servers?.length ? key.servers.join(', ') : 'Not used'} · {new Date(key.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <Button variant="ghost" size="icon-lg" onClick={() => setToDelete(key)} aria-label={`Delete ${key.name}`}>
                        <Trash2 className="text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Fingerprint</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Servers</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map(key => (
                        <TableRow key={key.id}>
                          <TableCell className="font-medium">{key.name}</TableCell>
                          <TableCell className="max-w-[18rem] truncate font-mono text-xs" title={key.fingerprint}>
                            {key.fingerprint}
                          </TableCell>
                          <TableCell>{key.key_type}</TableCell>
                          <TableCell className="max-w-[14rem] truncate">{key.servers?.length ? key.servers.join(', ') : '—'}</TableCell>
                          <TableCell>{new Date(key.created_at).toLocaleDateString()}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setToDelete(key)}>
                              <Trash2 />
                              Delete
                            </Button>
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
      </div>

      <Dialog open={!!generated} onOpenChange={open => !open && setGenerated(null)}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>New SSH key generated</DialogTitle>
            <DialogDescription>Copy the private key now if you need it elsewhere; add the public key to your servers.</DialogDescription>
          </DialogHeader>
          {generated && (
            <DialogBody className="space-y-3">
              <KeyBlock label="Public key" value={generated.public_key} />
              <KeyBlock label="Fingerprint" value={generated.fingerprint} />
              <KeyBlock label="Private key" value={generated.private_key} />
            </DialogBody>
          )}
          <DialogFooter>
            <Button size="lg" onClick={() => setGenerated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmDialog
        title="Delete SSH key?"
        confirmLabel="Delete"
        widgetTitle={toDelete?.name ?? ''}
        open={!!toDelete}
        onOpenChange={open => !open && setToDelete(null)}
        onConfirm={() => toDelete && handleDelete(toDelete)}
      />
    </>
  );
}
