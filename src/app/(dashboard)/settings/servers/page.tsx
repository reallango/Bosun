'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound, Pencil, Plus } from 'lucide-react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { EditServerModal } from '@/components/settings/EditServerModal';
import { ReprovisionDialog } from '@/components/settings/ReprovisionDialog';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { cn } from '@/lib/utils';
import { WakeButton } from '@/components/servers/WakeButton';
import { readJson } from '@/lib/api/readJson';

interface Server {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string | null;
  ssh_key_id: string | null;
  os_type: string | null;
  is_online: boolean;
  hostname?: string;
  notes?: string;
  mac_address?: string | null;
  mac_address_alt?: string | null;
  poll_enabled?: boolean;
  platform?: string;
  shell_user?: string | null;
}

function KeyBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="rounded bg-green-500/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">Configured</span>
  ) : (
    <span className="rounded bg-yellow-500/15 px-2 py-0.5 text-xs text-yellow-700 dark:text-yellow-400">No SSH key</span>
  );
}

function OnlineStatus({ online, monitored = true }: { online: boolean; monitored?: boolean }) {
  if (!monitored) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-yellow-700 dark:text-yellow-400">
        <span className="size-2 rounded-full bg-yellow-500" aria-hidden />
        Not monitored
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', online ? 'text-success' : 'text-muted-foreground')}>
      <span className={cn('size-2 rounded-full', online ? 'bg-green-500' : 'bg-gray-400')} aria-hidden />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [reprovision, setReprovision] = useState<Server | null>(null);

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/servers');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await readJson<any>(res);
      if (data.data) setServers(data.data.servers || data.data);
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const handleEditServer = (server: Server) => {
    setSelectedServer(server);
    setEditModalOpen(true);
  };

  return (
    <>
      <Header title="Servers" />
      <div className="page max-w-6xl">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Managed servers</CardTitle>
            <Button asChild size="lg">
              <Link href="/settings/servers/new">
                <Plus />
                Add server
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <LoadingSpinner />
            ) : servers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No servers added yet.</p>
            ) : (
              <>
                {/* Phones: stacked cards */}
                <ul className="divide-y md:hidden">
                  {servers.map(server => (
                    <li key={server.id} className="flex items-start gap-3 py-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <Link href={`/settings/servers/${server.id}`} className="truncate font-medium hover:underline">
                            {server.name}
                          </Link>
                          <OnlineStatus online={!!server.is_online} monitored={server.poll_enabled !== false} />
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {server.host}:{server.ssh_port}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <KeyBadge configured={!!server.ssh_key_id} />
                          {server.os_type && <span>{server.os_type}</span>}
                        </div>
                      </div>
                      <WakeButton serverId={server.id} serverName={server.name} macAddress={server.mac_address || server.mac_address_alt || null} iconOnly />
                      <Button variant="outline" size="icon-lg" onClick={() => setReprovision(server)} aria-label={`Re-provision ${server.name}`} title="Re-provision / rotate keys">
                        <KeyRound />
                      </Button>
                      <Button variant="outline" size="icon-lg" onClick={() => handleEditServer(server)} aria-label={`Edit ${server.name}`}>
                        <Pencil />
                      </Button>
                    </li>
                  ))}
                </ul>

                {/* md+: table */}
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Hostname</TableHead>
                        <TableHead>SSH</TableHead>
                        <TableHead>OS</TableHead>
                        <TableHead>MAC</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {servers.map(server => (
                        <TableRow key={server.id}>
                          <TableCell>
                            <Link href={`/settings/servers/${server.id}`} className="font-medium hover:underline">
                              {server.name}
                            </Link>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {server.host}:{server.ssh_port}
                          </TableCell>
                          <TableCell>
                            <KeyBadge configured={!!server.ssh_key_id} />
                          </TableCell>
                          <TableCell>{server.os_type || '-'}</TableCell>
                          <TableCell className="font-mono text-xs">{server.mac_address || server.mac_address_alt ? <>{server.mac_address}{server.mac_address_alt && <div className="text-muted-foreground">{server.mac_address_alt}</div>}</> : <span className="text-muted-foreground">-</span>}</TableCell>
                          <TableCell>
                            <OnlineStatus online={!!server.is_online} monitored={server.poll_enabled !== false} />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                            <WakeButton serverId={server.id} serverName={server.name} macAddress={server.mac_address || server.mac_address_alt || null} />
                            <Button variant="outline" size="sm" onClick={() => setReprovision(server)} title="Set this host up again with fresh keys, or rotate keys">
                              <KeyRound />
                              Re-provision
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => handleEditServer(server)}>
                              <Pencil />
                              Edit
                            </Button>
                            </div>
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
      <ReprovisionDialog server={reprovision} open={!!reprovision} onOpenChange={o => { if (!o) setReprovision(null); }} onDone={fetchServers} />
      <EditServerModal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        server={selectedServer}
        onSave={fetchServers}
      />
    </>
  );
}
