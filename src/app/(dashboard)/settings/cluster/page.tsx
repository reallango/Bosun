'use client';

import { useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface Node {
  id: string;
  address: string;
  is_leader: boolean;
  reachable: boolean;
}

export default function ClusterPage() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const res = await fetchWithAuth('/api/cluster/nodes');
        const data = await res.json();
        if (data.data) setNodes(data.data);
      } catch (err) {
        console.error('Failed to fetch nodes:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchNodes();
  }, []);

  return (
    <>
      <Header title="Cluster" />
      <div className="page max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle>Cluster nodes</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <LoadingSpinner />
            ) : nodes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No cluster nodes found.</p>
            ) : (
              // Scrolls horizontally inside the card on narrow screens.
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Node ID</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {nodes.map((node) => (
                    <TableRow key={node.id}>
                      <TableCell className="font-mono text-xs">{node.id}</TableCell>
                      <TableCell className="font-mono text-xs">{node.address}</TableCell>
                      <TableCell>
                        {node.is_leader ? (
                          <span className="font-medium text-success">Leader</span>
                        ) : (
                          <span className="text-muted-foreground">Follower</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={node.reachable ? 'text-success' : 'text-destructive'}>
                          {node.reachable ? 'Online' : 'Offline'}
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
