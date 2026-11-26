'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ageSeconds, formatAge } from './screen-page';

interface Props {
  /** When the screen's data was last loaded (ms since the epoch); 0 until the first load. */
  loadedAt: number;
  loading: boolean;
  onRefresh: () => void;
}

/** "updated 5 s ago" beside a refresh button; the age ticks every second. */
export function RefreshAge({ loadedAt, loading, onRefresh }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {loadedAt > 0 && (
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          updated {formatAge(ageSeconds(loadedAt, now))}
        </span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refresh the screen">
        <RefreshCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} aria-hidden />
        <span className="hidden sm:inline">Refresh</span>
      </Button>
    </div>
  );
}
