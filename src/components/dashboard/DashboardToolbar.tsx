'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { wakeServer } from '@/lib/api/wake';

interface DashboardToolbarProps {
  name: string;
  serverName?: string;
  type?: string;
  onAddWidget: () => void;
  serverId?: string;
}

export function DashboardToolbar({ name, serverName, type, onAddWidget, serverId }: DashboardToolbarProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [waking, setWaking] = useState(false);

  const handleEditServer = () => {
    setMenuOpen(false);
    if (serverId) {
      router.push(`/settings/servers/${serverId}`);
    }
  };

  const handleWake = async () => {
    setMenuOpen(false);
    if (!serverId) return;
    setWaking(true);
    try {
      const result = await wakeServer(serverId);
      alert(`Magic packet sent to ${result.mac} via ${result.broadcast}:${result.port}. The host should power on shortly.`);
    } catch (err) {
      alert(`Failed to wake server: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{name}</h1>
        {serverName && (
          <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-sm">{serverName}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onAddWidget} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          + Add Widget
        </button>
        {type === 'server' && serverId && (
          <button
            onClick={handleWake}
            disabled={waking}
            title="Send a Wake-on-LAN magic packet to this server"
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {waking ? 'Waking...' : 'Wake'}
          </button>
        )}
        {type === 'server' && serverId && (
          <div className="relative">
            <button 
              onClick={() => setMenuOpen(!menuOpen)} 
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              ⋮
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border rounded shadow-lg z-10">
                <button
                  onClick={() => { setMenuOpen(false); onAddWidget(); }}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                >
                  Add Widget
                </button>
                <button
                  onClick={handleWake}
                  disabled={waking}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 text-sm disabled:opacity-50"
                >
                  {waking ? 'Waking...' : 'Wake (WoL)'}
                </button>
                <button
                  onClick={handleEditServer}
                  className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                >
                  Edit Server
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}