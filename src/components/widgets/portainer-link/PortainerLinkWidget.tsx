'use client';

import { useWidgetData } from '@/hooks/useWidgetData';

interface PortainerLinkWidgetProps {
  widgetId: string;
  serverId: string;
}

export function PortainerLinkWidget({ widgetId, serverId }: PortainerLinkWidgetProps) {
  const { data, isLoading, error } = useWidgetData(widgetId, 60);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Loading...</div>;
  }

  if (error) {
    return <div className="text-red-500 text-sm p-2">Error: {error}</div>;
  }

  const linkData = data as { url?: string; name?: string } | null;

  if (!linkData?.url) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="text-gray-500 text-sm">No Portainer configured</div>
        <div className="text-xs text-gray-400">Add portainer_url in server settings</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-2">
      <div className="text-4xl">🐳</div>
      <div className="text-center">
        <div className="font-medium">{linkData.name || 'Portainer'}</div>
        <div className="text-xs text-gray-500">{linkData.url}</div>
      </div>
      <a
        href={linkData.url}
        target="_blank"
        rel="noopener noreferrer"
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
      >
        Open Portainer
      </a>
    </div>
  );
}