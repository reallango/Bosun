'use client';

import { Fan, Thermometer, Zap } from 'lucide-react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';
import { WidgetEmpty, WidgetPlaceholder } from '@/components/widgets/WidgetPlaceholder';
import { UsageBar } from '@/components/widgets/UsageBar';
import { formatMB, pct } from '@/components/widgets/format';

interface GPUInfo {
  name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  utilization_percent: number;
  temperature_c: number;
  power_watts: number;
  index?: number;
  fan_percent?: number;
}

/** Data may be a single GPU object, an array of GPUs, or { gpus: [...] }. */
function toGpuList(data: unknown): GPUInfo[] {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter(g => g && typeof g === 'object') as GPUInfo[];
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.gpus)) return toGpuList(obj.gpus);
    if (obj.source === 'placeholder') return [];
    if ('name' in obj || 'vram_total_mb' in obj || 'utilization_percent' in obj) return [obj as unknown as GPUInfo];
  }
  return [];
}

function GPURow({ gpu, index, multi }: { gpu: GPUInfo; index: number; multi: boolean }) {
  const vramTotal = Number(gpu.vram_total_mb) || 0;
  const vramUsed = Number(gpu.vram_used_mb) || 0;
  const vramPercent = vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0;
  const util = pct(gpu.utilization_percent);

  return (
    <li className="min-w-0 space-y-2 rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={gpu.name}>
          {multi && <span className="mr-1 text-muted-foreground">#{gpu.index ?? index}</span>}
          {gpu.name || 'GPU'}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {Number.isFinite(gpu.temperature_c) && (
            <span className="inline-flex items-center gap-0.5" title="Temperature">
              <Thermometer className="size-3" aria-hidden />
              {gpu.temperature_c}°C
            </span>
          )}
          {Number.isFinite(gpu.power_watts) && (
            <span className="hidden items-center gap-0.5 @[14rem]:inline-flex" title="Power">
              <Zap className="size-3" aria-hidden />
              {Math.round(gpu.power_watts)}W
            </span>
          )}
          {Number.isFinite(gpu.fan_percent) && (
            <span className="hidden items-center gap-0.5 @[20rem]:inline-flex" title="Fan">
              <Fan className="size-3" aria-hidden />
              {gpu.fan_percent}%
            </span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 @[14rem]:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 flex justify-between gap-2 text-xs">
            <span className="text-muted-foreground">GPU</span>
            <span className="tabular-nums">{Math.round(util)}%</span>
          </div>
          <UsageBar value={util} colorClass="bg-green-500" />
        </div>
        <div className="min-w-0">
          <div className="mb-1 flex justify-between gap-2 text-xs">
            <span className="text-muted-foreground">VRAM</span>
            <span className="truncate tabular-nums">
              {formatMB(vramUsed)} / {formatMB(vramTotal)}
            </span>
          </div>
          <UsageBar value={vramPercent} colorClass="bg-blue-500" />
        </div>
      </div>
    </li>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function GPUMonitoringWidget({ widgetId, serverId }: { widgetId: string; serverId: string }) {
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, 10);

  if (isLoading) return <WidgetLoading label="Loading GPU info…" />;
  if (error) return <WidgetError error={error} onRetry={refresh} />;
  if ((data as { source?: string } | null)?.source === 'placeholder') return <WidgetPlaceholder />;

  const gpus = toGpuList(data);
  if (gpus.length === 0) return <WidgetEmpty>No GPU detected</WidgetEmpty>;

  return (
    <ul className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {gpus.map((gpu, i) => (
        <GPURow key={`${gpu.index ?? i}-${gpu.name}`} gpu={gpu} index={i} multi={gpus.length > 1} />
      ))}
    </ul>
  );
}
