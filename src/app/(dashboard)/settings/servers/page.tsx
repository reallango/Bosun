'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { EditServerModal } from '@/components/settings/EditServerModal';

interface SSHKey {
  id: string;
  name: string;
}

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
}

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      const res = await fetchWithAuth('/api/servers');
      const data = await res.json();
      if (data.data) setServers(data.data.servers || data.data);
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleEditServer = (server: Server) => {
    setSelectedServer(server);
    setEditModalOpen(true);
  };

  return (
    <>
      <Header title="Servers" />
      <div className="p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold">Managed Servers</h2>
          <Link href="/settings/servers/new">
            <Button>Add Server</Button>
          </Link>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Servers</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-gray-500">Loading...</p>
            ) : servers.length === 0 ? (
              <p className="text-gray-500">No servers added yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Hostname</TableHead>
                    <TableHead>SSH</TableHead>
                    <TableHead>OS</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {servers.map((server) => (
                    <TableRow key={server.id}>
                      <TableCell>
                        <Link href={`/settings/servers/${server.id}`} className="hover:underline">
                          {server.name}
                        </Link>
                      </TableCell>
                      <TableCell>{server.host}:{server.ssh_port}</TableCell>
                      <TableCell>
                        {server.ssh_key_id ? (
                          <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">Configured</span>
                        ) : (
                          <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-700 rounded">No SSH Key</span>
                        )}
                      </TableCell>
                      <TableCell>{server.os_type || '-'}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center ${server.is_online ? 'text-green-600' : 'text-gray-400'}`}>
                          <span className={`w-2 h-2 rounded-full mr-2 ${server.is_online ? 'bg-green-500' : 'bg-gray-400'}`} />
                          {server.is_online ? 'Online' : 'Offline'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => handleEditServer(server)}
                          className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                        >
                          Edit
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
      <EditServerModal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        server={selectedServer}
        onSave={fetchServers}
      />
    </>
  );
}