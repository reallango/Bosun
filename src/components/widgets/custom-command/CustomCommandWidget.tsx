'use client';

import { useEffect, useState } from 'react';
import { useWidgetData } from '@/hooks/useWidgetData';
import { WidgetLoading } from '@/components/widgets/WidgetLoading';
import { WidgetError } from '@/components/widgets/WidgetError';

interface CustomCommandWidgetProps {
  widgetId: string;
  serverId: string;
}

interface CommandData {
  output?: string;
  exitCode?: number;
  timedOut?: boolean;
  account?: string;
  intervalSec?: number;
}

/**
 * Shows the output of the widget's one saved command. The command runs as the host's non-admin
 * account and repeats at the interval set in the widget's settings (the first fetch uses the default
 * until the server reports the chosen interval). There is no box to type commands into: ad-hoc commands
 * are an API feature (/api/servers/:id/exec and /shell/exec).
 */
export function CustomCommandWidget({ widgetId, serverId }: CustomCommandWidgetProps) {
  const [intervalSec, setIntervalSec] = useState(30);
  const { data, isLoading, error, refresh } = useWidgetData(widgetId, intervalSec);
  const output = data as CommandData | null;
  const reported = output?.intervalSec;
  useEffect(() => { if (reported && reported !== intervalSec) setIntervalSec(reported); }, [reported, intervalSec]);

  if (isLoading && !output) return <WidgetLoading />;
  if (error && !output?.output) return <WidgetError error={error} onRetry={refresh} serverId={serverId} />;

  const failed = output && (output.timedOut || (typeof output.exitCode === 'number' && output.exitCode !== 0));
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {failed && (
        <div role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {output?.timedOut ? 'The command timed out.' : `The command exited with code ${output?.exitCode}.`}
        </div>
      )}
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-md bg-black p-2 font-mono text-[11px] leading-snug text-green-400 @md:text-xs">
        {output?.output || '(no output)'}
      </pre>
      {output?.account && <div className="text-[10px] text-muted-foreground">as {output.account}, every {intervalSec} s</div>}
    </div>
  );
}
