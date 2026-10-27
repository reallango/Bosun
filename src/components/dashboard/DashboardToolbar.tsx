'use client';

import { WakeButton } from '@/components/servers/WakeButton';
import { useRouter } from 'next/navigation';
import { Check, EllipsisVertical, LayoutGrid, Pencil, Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface DashboardToolbarProps {
  name: string;
  serverName?: string;
  type?: string;
  onAddWidget: () => void;
  serverId?: string;
  widgetCount?: number;
  /** Layout edit mode (drag & resize). Omit onToggleEdit to hide the toggle. */
  editing?: boolean;
  onToggleEdit?: () => void;
}

export function DashboardToolbar({ name, serverName, type, onAddWidget, serverId, widgetCount, editing, onToggleEdit }: DashboardToolbarProps) {
  const router = useRouter();

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 sm:mb-4">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <LayoutGrid className="size-4 shrink-0" aria-hidden />
        <span className="truncate">
          <span className="sr-only">{name}: </span>
          {typeof widgetCount === 'number' ? `${widgetCount} widget${widgetCount === 1 ? '' : 's'}` : name}
        </span>
        {serverName && (
          <span className="hidden max-w-[12rem] truncate rounded-full bg-muted px-2 py-0.5 text-xs sm:inline-block">{serverName}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2">
        {onToggleEdit && (
          <Button
            variant={editing ? 'default' : 'outline'}
            size="lg"
            onClick={onToggleEdit}
            aria-pressed={!!editing}
            aria-label={editing ? 'Finish editing layout' : 'Edit layout'}
          >
            {editing ? <Check /> : <Pencil />}
            <span className="hidden xs:inline">{editing ? 'Done' : 'Edit layout'}</span>
          </Button>
        )}
        <Button size="lg" onClick={onAddWidget} aria-label="Add widget">
          <Plus />
          <span className="hidden xs:inline">Add widget</span>
        </Button>
        {type === 'server' && serverId && (
          <WakeButton serverId={serverId} serverName={serverName || name} iconOnly className="size-9" />
        )}
        {type === 'server' && serverId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-lg" aria-label="Server actions">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onAddWidget}>
                <Plus />
                Add widget
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push(`/settings/servers/${serverId}`)}>
                <Server />
                Edit server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
