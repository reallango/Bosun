'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ErrorState } from '@/components/shared/ErrorState';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { formatDistanceToNow } from '@/lib/utils/date';
import { cn } from '@/lib/utils';

interface AuditLog {
  id: string;
  user_email: string;
  action: string;
  resource_type: string;
  resource_id: string;
  status: string;
  created_at: string;
}

function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-xs',
        action === 'delete'
          ? 'bg-red-500/15 text-red-700 dark:text-red-400'
          : action === 'create'
            ? 'bg-green-500/15 text-green-700 dark:text-green-400'
            : 'bg-muted text-foreground'
      )}
    >
      {action}
    </span>
  );
}

function StatusText({ status }: { status: string }) {
  return <span className={status === 'success' ? 'text-success' : 'text-destructive'}>{status}</span>;
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState('');
  const [filterUser, setFilterUser] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterAction) params.set('action', filterAction);
      if (filterUser) params.set('user_id', filterUser);
      const res = await fetchWithAuth(`/api/audit-logs?${params}`);
      const json = await res.json();
      if (json.error) {
        setError(json.error.message);
      } else {
        setLogs(json?.data?.logs || []);
      }
    } catch {
      setError('Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterUser]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <>
      <Header title="Audit Log" />
      <div className="page max-w-6xl space-y-4">
        <div className="flex flex-col gap-2 xs:flex-row">
          <label className="xs:w-48">
            <span className="sr-only">Filter by action</span>
            <select value={filterAction} onChange={e => setFilterAction(e.target.value)} className="form-select">
              <option value="">All actions</option>
              <option value="login">Login</option>
              <option value="logout">Logout</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
              <option value="execute">Execute</option>
            </select>
          </label>
          <label className="min-w-0 flex-1 xs:max-w-xs">
            <span className="sr-only">Filter by user ID</span>
            <input
              placeholder="Filter by user ID…"
              value={filterUser}
              onChange={e => setFilterUser(e.target.value)}
              className="form-input"
            />
          </label>
        </div>

        <Card className="py-0">
          <CardContent className="px-0">
            {loading ? (
              <LoadingSpinner />
            ) : error ? (
              <ErrorState message={error} onRetry={fetchData} />
            ) : logs.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No audit logs found</div>
            ) : (
              <>
                <ul className="divide-y md:hidden">
                  {logs.map(log => (
                    <li key={log.id} className="space-y-1 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <ActionBadge action={log.action} />
                        <span className="shrink-0 text-xs text-muted-foreground">{formatDistanceToNow(new Date(log.created_at))}</span>
                      </div>
                      <div className="truncate">{log.user_email}</div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-muted-foreground">
                          {log.resource_type}
                          {log.resource_id && ` (${log.resource_id})`}
                        </span>
                        <StatusText status={log.status} />
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="px-4">Time</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Resource</TableHead>
                        <TableHead className="px-4">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map(log => (
                        <TableRow key={log.id}>
                          <TableCell className="px-4 text-muted-foreground">{formatDistanceToNow(new Date(log.created_at))}</TableCell>
                          <TableCell className="max-w-[16rem] truncate">{log.user_email}</TableCell>
                          <TableCell>
                            <ActionBadge action={log.action} />
                          </TableCell>
                          <TableCell className="max-w-[20rem] truncate">
                            {log.resource_type}
                            {log.resource_id && <span className="text-muted-foreground"> ({log.resource_id})</span>}
                          </TableCell>
                          <TableCell className="px-4">
                            <StatusText status={log.status} />
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
    </>
  );
}
