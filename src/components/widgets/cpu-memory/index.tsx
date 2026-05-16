'use client';

import { CircularGauge } from '@/components/shared/CircularGauge';

export function CPUMemoryWidget({ serverId }: { serverId: string }) {
  return (
    <div className="flex gap-4 justify-center">
      <CircularGauge value={45} label="CPU" />
      <CircularGauge value={62} label="Memory" />
    </div>
  );
}