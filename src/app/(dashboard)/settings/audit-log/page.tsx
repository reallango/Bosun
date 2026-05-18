'use client';

import { useState, useEffect } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { formatDistanceToNow } from '@/lib/utils/date';

interface AuditLog {
  id: string;
  user_email: string;
  action: string;
  resource_type: string;
  resource_id: string;
  status: string;
  created_at: string;
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState('');
  const [filterUser, setFilterUser] = useState('');

  useEffect(() => {
    fetchData();
  }, [filterAction, filterUser]);

  const fetchData = async () => {
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
    } catch (err) {
      setError('Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Audit Log</h1>

      <div className="flex gap-4 mb-6">
        <select value={filterAction} onChange={e => setFilterAction(e.target.value)} className="border rounded px-3 py-2">
          <option value="">All Actions</option>
          <option value="login">Login</option>
          <option value="logout">Logout</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="delete">Delete</option>
          <option value="execute">Execute</option>
        </select>
        <input
          placeholder="Filter by user ID..."
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          className="border rounded px-3 py-2"
        />
      </div>

      {loading ? (
        <div className="text-center py-8">Loading...</div>
      ) : error ? (
        <div className="text-red-500 text-center py-8">{error}</div>
      ) : logs.length === 0 ? (
        <div className="text-gray-500 text-center py-8">No audit logs found</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium">Time</th>
                <th className="text-left px-4 py-3 text-sm font-medium">User</th>
                <th className="text-left px-4 py-3 text-sm font-medium">Action</th>
                <th className="text-left px-4 py-3 text-sm font-medium">Resource</th>
                <th className="text-left px-4 py-3 text-sm font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDistanceToNow(new Date(log.created_at))}
                  </td>
                  <td className="px-4 py-3 text-sm">{log.user_email}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-1 rounded text-xs ${
                      log.action === 'delete' ? 'bg-red-100 text-red-700' :
                      log.action === 'create' ? 'bg-green-100 text-green-700' :
                      'bg-gray-100'
                    }`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {log.resource_type}
                    {log.resource_id && <span className="text-gray-400"> ({log.resource_id})</span>}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={log.status === 'success' ? 'text-green-600' : 'text-red-600'}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}