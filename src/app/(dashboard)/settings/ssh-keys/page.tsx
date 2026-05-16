'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface SSHKey {
  id: string;
  name: string;
  fingerprint: string;
  key_type: string;
  created_at: string;
}

export default function SSHKeysPage() {
  const router = useRouter();
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/ssh-keys');
      const data = await res.json();
      if (data.data) setKeys(data.data);
    } catch (err) {
      console.error('Failed to fetch keys:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    try {
      const res = await fetch('/api/ssh-keys/generate', { method: 'POST' });
      const data = await res.json();
      if (data.data) {
        alert(`Generated new key:\n\nPrivate Key:\n${data.data.private_key}\n\nPublic Key:\n${data.data.public_key}\n\nFingerprint:\n${data.data.fingerprint}`);
        fetchKeys();
      }
    } catch (err) {
      console.error('Failed to generate key:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this SSH key?')) return;
    
    try {
      const res = await fetch(`/api/ssh-keys/${id}`, { method: 'DELETE' });
      if (res.ok) fetchKeys();
    } catch (err) {
      console.error('Failed to delete key:', err);
    }
  };

  return (
    <>
      <Header title="SSH Keys" />
      <div className="p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold">SSH Keys</h2>
          <Button onClick={handleGenerate}>Generate New Key</Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>SSH Keys</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-gray-500">Loading...</p>
            ) : keys.length === 0 ? (
              <p className="text-gray-500">No SSH keys. Generate one to get started.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Fingerprint</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>{key.name}</TableCell>
                      <TableCell className="font-mono text-sm">{key.fingerprint}</TableCell>
                      <TableCell>{key.key_type}</TableCell>
                      <TableCell>{new Date(key.created_at).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(key.id)}>
                          Delete
                        </Button>
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