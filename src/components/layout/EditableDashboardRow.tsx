'use client';

import { ChevronDown, ChevronUp, LayoutDashboard, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

const iconButton =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors ' +
  'hover:bg-sidebar-accent/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'disabled:pointer-events-none disabled:opacity-30';

interface EditableDashboardRowProps {
  name: string;
  isFirst: boolean;
  isLast: boolean;
  onRename: () => void;
  onMove: (direction: -1 | 1) => void;
}

/** A dashboard in the sidebar's edit mode: rename, and move up or down. */
export function EditableDashboardRow({ name, isFirst, isLast, onRename, onMove }: EditableDashboardRowProps) {
  return (
    <div className={cn('flex min-h-9 items-center gap-1 rounded-md bg-sidebar-accent/30 pl-3 pr-1 text-sm text-sidebar-foreground')}>
      <LayoutDashboard className="size-4 shrink-0 text-sidebar-muted" aria-hidden />
      <span className="ml-2 min-w-0 flex-1 truncate">{name}</span>
      <button type="button" className={iconButton} onClick={onRename} aria-label={`Rename ${name}`} title="Rename">
        <Pencil className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={iconButton} onClick={() => onMove(-1)} disabled={isFirst} aria-label={`Move ${name} up`} title="Move up">
        <ChevronUp className="size-4" aria-hidden />
      </button>
      <button type="button" className={iconButton} onClick={() => onMove(1)} disabled={isLast} aria-label={`Move ${name} down`} title="Move down">
        <ChevronDown className="size-4" aria-hidden />
      </button>
    </div>
  );
}
