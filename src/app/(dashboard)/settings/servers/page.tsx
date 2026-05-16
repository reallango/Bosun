'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Server {
  id: string;
  name: string;
  hostname: string;
  ssh_port: number;
  os_type: string | null;
  is_online: boolean;
}

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      const res = await fetch('/api/servers');
      const data = await res.json();
      if (data.data) setServers(data.data);
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    } finally {
      setLoading(false);
    }
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
                    <TableHead>OS</TableHead>
                    <TableHead>Status</TableHead>
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
                      <TableCell>{server.hostname}:{server.ssh_port}</TableCell>
                      <TableCell>{server.os_type || '-'}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center ${server.is_online ? 'text-green-600' : 'text-gray-400'}`}>
                          <span className={`w-2 h-2 rounded-full mr-2 ${server.is_online ? 'bg-green-500' : 'bg-gray-400'}`} />
                          {server.is_online ? 'Online' : 'Offline'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}