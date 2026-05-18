'use client';

import { useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { StatusBadge } from '@/components/shared/StatusBadge';

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  created: string;
  ports: string;
}

interface DockerContainersWidgetProps {
  widgetId: string;
  serverId: string;
}

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

export function DockerContainersWidget({ widgetId, serverId }: DockerContainersWidgetProps) {
  const { data, isLoading, error } = useWidgetData(widgetId, 15);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const containers = (data as Container[]) || [];

  const handleAction = async (containerId: string, action: 'start' | 'stop' | 'restart') => {
    setActionLoading(containerId);
    try {
      await fetchWithAuth(`/api/servers/${serverId}/containers/${containerId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
    } catch (err) {
      console.error('Action failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Loading containers...</div>;
  }

  if (error) {
    return <div className="text-red-500 text-sm p-2">Error: {error}</div>;
  }

  if (!containers.length) {
    return <div className="text-gray-500 text-sm p-2">No containers found</div>;
  }

  return (
    <div className="flex flex-col gap-1 p-2 text-sm overflow-auto">
      {containers.slice(0, 10).map((container) => (
        <div key={container.id} className="flex items-center justify-between gap-2 text-xs">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <StatusBadge status={container.state === 'running' ? 'online' : 'offline'} />
              <span className="font-medium truncate" title={container.name}>
                {truncate(container.name, 20)}
              </span>
            </div>
            <div className="text-gray-500 text-xs truncate" title={container.image}>
              {truncate(container.image, 25)}
            </div>
          </div>
          <div className="flex gap-1">
            {container.state === 'running' ? (
              <>
                <button
                  onClick={() => handleAction(container.id, 'stop')}
                  disabled={actionLoading === container.id}
                  className="px-1.5 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
                >
                  ⏹
                </button>
                <button
                  onClick={() => handleAction(container.id, 'restart')}
                  disabled={actionLoading === container.id}
                  className="px-1.5 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
                >
                  🔄
                </button>
              </>
            ) : (
              <button
                onClick={() => handleAction(container.id, 'start')}
                disabled={actionLoading === container.id}
                className="px-1.5 py-0.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
              >
                ▶
              </button>
            )}
          </div>
        </div>
      ))}
      {containers.length > 10 && (
        <div className="text-gray-500 text-xs">+{containers.length - 10} more</div>
      )}
    </div>
  );
}