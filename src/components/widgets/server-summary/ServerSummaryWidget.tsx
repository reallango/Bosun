'use client';

import { useWidgetData } from '@/hooks/useWidgetData';
import { StatusBadge } from '@/components/shared/StatusBadge';

export function ServerSummaryWidget({ widgetId, serverId, serverName }: { widgetId: string; serverId: string; serverName?: string }) {
  const { data, isLoading: loading, error: fetchError } = useWidgetData(widgetId, 15);

  if (loading) {
    return <div className="flex items-center justify-center h-full">Loading...</div>;
  }

  if (fetchError) {
    return <div className="text-red-500 text-sm">Error: {fetchError}</div>;
  }

  const serverData = data as { is_online?: boolean; os_type?: string; hostname?: string } | null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">{serverName || serverId}</span>
        <StatusBadge status={serverData?.is_online ? 'online' : 'offline'} />
      </div>
      <div className="text-sm text-gray-600 dark:text-gray-400">
        {serverData?.os_type || 'Unknown OS'}
      </div>
      {serverData?.hostname && (
        <div className="text-xs text-gray-500">{serverData.hostname}</div>
      )}
    </div>
  );
}