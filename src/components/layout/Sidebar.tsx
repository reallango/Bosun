'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface Server {
  id: string;
  name: string;
  hostname: string;
  is_online: number;
}

interface Dashboard {
  id: string;
  name: string;
  type: string;
  server_id: string | null;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [servers, setServers] = useState<Server[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);

  useEffect(() => {
    fetch('/api/servers')
      .then(r => r.json())
      .then(j => setServers(j.data || []))
      .catch(() => {});
    fetch('/api/dashboards')
      .then(r => r.json())
      .then(j => setDashboards(j.data?.dashboards || j.data || []))
      .catch(() => {});
  }, []);

  return (
    <div className="w-64 h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <Link href="/" className="text-xl font-bold">Bosun</Link>
      </div>
      <nav className="flex-1 p-4 space-y-4 overflow-auto">
        {/* Home */}
        <Link
          href="/"
          className={cn(
            'block px-3 py-2 rounded-md text-sm',
            pathname === '/' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
          )}
        >
          🏠 Home
        </Link>

        {/* Servers */}
        <div>
          <div className="px-3 py-1 text-xs text-gray-500 uppercase">Servers</div>
          {servers.map(s => (
            <Link
              key={s.id}
              href={`/settings/servers/${s.id}`}
              className="flex items-center gap-2 px-3 py-1 text-sm text-gray-400 hover:text-white"
            >
              <span className={`w-2 h-2 rounded-full ${s.is_online ? 'bg-green-500' : 'bg-gray-500'}`} />
              {s.name}
            </Link>
          ))}
          <Link href="/settings/servers/new" className="block px-3 py-1 text-sm text-blue-400 hover:text-white">
            + Add Server
          </Link>
        </div>

        {/* Dashboards */}
        {dashboards.filter(d => d.type === 'custom').length > 0 && (
          <div>
            <div className="px-3 py-1 text-xs text-gray-500 uppercase">Dashboards</div>
            {dashboards.filter(d => d.type === 'custom').map(d => (
              <Link
                key={d.id}
                href={`/dashboards/${d.id}`}
                className="block px-3 py-1 text-sm text-gray-400 hover:text-white"
              >
                📊 {d.name}
              </Link>
            ))}
          </div>
        )}

        {/* Settings */}
        <div className="pt-2 border-t border-gray-800">
          <div className="px-3 py-1 text-xs text-gray-500 uppercase">Settings</div>
          <Link href="/settings/servers" className="block px-3 py-1 text-sm text-gray-400 hover:text-white">
            Servers
          </Link>
          <Link href="/settings/ssh-keys" className="block px-3 py-1 text-sm text-gray-400 hover:text-white">
            SSH Keys
          </Link>
          <Link href="/settings/cluster" className="block px-3 py-1 text-sm text-gray-400 hover:text-white">
            Cluster
          </Link>
        </div>
      </nav>
    </div>
  );
}