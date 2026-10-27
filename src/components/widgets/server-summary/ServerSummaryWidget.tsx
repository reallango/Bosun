'use client';

import { Server } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';

export function ServerSummaryWidget({ widgetId, serverId, serverName }: { widgetId: string; serverId: string; serverName?: string }) {
  const { data, isLoading: loading, error: fetchError, refresh } = useWidgetData(widgetId, 15);

  if (loading) return <WidgetLoading />;
  if (fetchError) return <WidgetError error={fetchError} onRetry={refresh} />;

  const serverData = data as { is_online?: boolean; os_type?: string; hostname?: string } | null;

  return (
    <div className="flex h-full items-center gap-3">
      <div className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary @[14rem]:flex">
        <Server className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium" title={serverName || serverId}>{serverName || serverId}</span>
          <StatusBadge status={serverData?.is_online ? 'online' : 'offline'} />
        </div>
        <div className="truncate text-sm text-muted-foreground">{serverData?.os_type || 'Unknown OS'}</div>
        {serverData?.hostname && <div className="truncate font-mono text-xs text-muted-foreground/80">{serverData.hostname}</div>}
      </div>
    </div>
  );
}
