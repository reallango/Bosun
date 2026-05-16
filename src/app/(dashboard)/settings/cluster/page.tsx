'use client';

import { useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
    fetchNodes();
  }, []);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/cluster/nodes');
      const data = await res.json();
      if (data.data) setNodes(data.data);
    } catch (err) {
      console.error('Failed to fetch nodes:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Header title="Cluster" />
      <div className="p-8">
        <Card>
          <CardHeader>
            <CardTitle>Cluster Nodes</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-gray-500">Loading...</p>
            ) : nodes.length === 0 ? (
              <p className="text-gray-500">No cluster nodes found.</p>
            ) : (
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
                      <TableCell className="font-mono text-sm">{node.id}</TableCell>
                      <TableCell>{node.address}</TableCell>
                      <TableCell>
                        {node.is_leader ? (
                          <span className="text-green-600">Leader</span>
                        ) : (
                          <span className="text-gray-500">Follower</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={node.reachable ? 'text-green-600' : 'text-red-600'}>
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