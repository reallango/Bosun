'use client';

import { useState } from 'react';
import { Loader2, Power, RotateCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';
import { powerServer, type PowerAction } from '@/lib/api/power';
import { useWakeServer } from './WakeButton';

interface ServerPowerMenuProps {
  serverId: string;
  serverName: string;
  className?: string;
}

const COPY: Record<PowerAction, { title: (n: string) => string; description: (n: string) => string; confirm: string; done: (n: string) => string; failed: (n: string) => string }> = {
  restart: {
    title: n => `Restart ${n}?`,
    description: n => `${n} will reboot. Running services and sessions on it are interrupted and it is unreachable until it is back up. This action will be logged.`,
    confirm: 'Restart',
    done: n => `Restart sent to ${n}`,
    failed: n => `Could not restart ${n}`,
  },
  shutdown: {
    title: n => `Shut down ${n}?`,
    description: n => `${n} will power off. It stays off until it is started again, for example with Wake-on-LAN or at the machine. This action will be logged.`,
    confirm: 'Shut down',
    done: n => `Shutdown sent to ${n}`,
    failed: n => `Could not shut down ${n}`,
  },
};

/**
 * Power menu for a server (operator+): Wake, Restart and Shut down. Restart and
 * shut down ask for confirmation first.
 */
export function ServerPowerMenu({ serverId, serverName, className }: ServerPowerMenuProps) {
  const { toast } = useToast();
  const { can } = useAuth();
  const { wake, waking, installDialog } = useWakeServer(serverId, serverName);
  const [pending, setPending] = useState<PowerAction | null>(null);
  // Each item needs its own permission for this server; with none of them there is no menu.
  const canWake = can('power.wake', serverId);
  const canRestart = can('power.restart', serverId);
  const canShutdown = can('power.shutdown', serverId);
  if (!canWake && !canRestart && !canShutdown) return null;

  const name = serverName || 'server';
  const copy = pending ? COPY[pending] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-lg" className={className} aria-label={`Power options for ${name}`} title="Power" disabled={waking}>
            {waking ? <Loader2 className="animate-spin" aria-hidden /> : <Power aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {canWake && (
            <DropdownMenuItem onSelect={() => { void wake(); }}>
              <Zap />
              Wake
            </DropdownMenuItem>
          )}
          {canRestart && (
            <DropdownMenuItem onSelect={() => setPending('restart')}>
              <RotateCw />
              Restart
            </DropdownMenuItem>
          )}
          {canShutdown && (canWake || canRestart) && <DropdownMenuSeparator />}
          {canShutdown && (
            <DropdownMenuItem variant="destructive" onSelect={() => setPending('shutdown')}>
              <Power />
              Shut down
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmActionDialog
        open={!!pending}
        onOpenChange={o => { if (!o) setPending(null); }}
        title={copy ? copy.title(name) : ''}
        description={copy ? copy.description(name) : ''}
        confirmLabel={copy?.confirm ?? ''}
        destructive
        onConfirm={async () => {
          if (!pending) return;
          try {
            await powerServer(serverId, pending);
          } catch (err) {
            toast(COPY[pending].failed(name), { variant: 'error', description: err instanceof Error ? err.message : String(err) });
            throw err;
          }
          toast(COPY[pending].done(name), { variant: 'success', description: 'The server will go offline shortly.' });
        }}
      />
      {installDialog}
    </>
  );
}
