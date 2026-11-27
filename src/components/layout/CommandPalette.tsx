'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, LayoutGrid, Search, Server, Settings, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SETTINGS_NAV } from '@/lib/settings/nav';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { searchPalette, type PaletteItem, type PaletteKind } from '@/lib/search/palette';

interface PaletteDashboard { id: string; name: string; type: string }
interface PaletteServer { id: string; name: string; host?: string; hostname?: string }
interface PaletteScreen { widgetId: string; screenId: string; title: string; serverName?: string | null }

interface PaletteData {
  dashboards: PaletteDashboard[];
  servers: PaletteServer[];
  screens: PaletteScreen[];
}

const KIND_ICON: Record<PaletteKind, LucideIcon> = {
  dashboard: LayoutDashboard,
  server: Server,
  settings: Settings,
  screen: LayoutGrid,
};

const KIND_LABEL: Record<PaletteKind, string> = {
  dashboard: 'Dashboard',
  server: 'Server',
  settings: 'Settings',
  screen: 'Widget page',
};

const optionId = (index: number) => `palette-option-${index}`;

/** The shortcut shown in the trigger; filled in after mount so the server-rendered label stays stable. */
export function useShortcutHint(): string {
  const [hint, setHint] = useState('Ctrl K');
  useEffect(() => {
    if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) setHint('⌘K');
  }, []);
  return hint;
}

function buildItems(data: PaletteData): PaletteItem[] {
  const items: PaletteItem[] = [];

  for (const dashboard of data.dashboards) {
    if (dashboard.type === 'server') continue;
    items.push({
      id: `dashboard:${dashboard.id}`,
      kind: 'dashboard',
      label: dashboard.name || (dashboard.type === 'home' ? 'Home' : 'Dashboard'),
      detail: dashboard.type === 'home' ? 'Home dashboard' : 'Dashboard',
      href: dashboard.type === 'home' ? '/' : `/dashboards/${dashboard.id}`,
    });
  }

  for (const server of data.servers) {
    items.push({
      id: `server:${server.id}`,
      kind: 'server',
      label: server.name,
      detail: server.host || server.hostname || 'Server',
      href: `/servers/${server.id}`,
    });
  }

  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      items.push({
        id: `settings:${item.href}`,
        kind: 'settings',
        label: item.label,
        detail: `Settings · ${group.label}`,
        href: item.href,
        keywords: [group.label, 'settings'],
      });
    }
  }

  for (const screen of data.screens) {
    const server = screen.serverName || 'Server';
    const label = screen.title.toLowerCase().includes(server.toLowerCase()) ? screen.title : `${screen.title} on ${server}`;
    items.push({
      id: `screen:${screen.widgetId}:${screen.screenId}`,
      kind: 'screen',
      label,
      detail: 'Widget page',
      href: `/widgets/${encodeURIComponent(screen.widgetId)}/${encodeURIComponent(screen.screenId)}`,
      keywords: [screen.title, server],
    });
  }

  return items;
}

/** Small sidebar button that opens the palette; also the way to discover the shortcut. */
export function PaletteTrigger({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const hint = useShortcutHint();
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? `Search (${hint})` : undefined}
      className={cn(
        'flex min-h-9 w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1.5 text-sm text-sidebar-muted transition-colors',
        'hover:bg-sidebar-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        collapsed && 'justify-center px-0'
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Search</span>
          <kbd className="shrink-0 rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 text-[10px] font-medium text-sidebar-muted">
            {hint}
          </kbd>
        </>
      )}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Search ({hint})</TooltipContent>
    </Tooltip>
  );
}

/**
 * Ctrl+K / Cmd+K palette over the things a person can open: dashboards, servers, settings pages and the full-page
 * screens of widgets they may see. Results are filtered and ranked by the pure function in lib/search/palette.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [data, setData] = useState<PaletteData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const get = <T,>(url: string) => fetchWithAuth(url).then(res => readJson<T>(res)).catch(() => null);
    setLoading(true);
    Promise.all([
      get<{ data?: { dashboards?: PaletteDashboard[] } }>('/api/dashboards'),
      get<{ data?: { servers?: PaletteServer[] } }>('/api/servers'),
      get<{ data?: { screens?: PaletteScreen[] } }>('/api/widgets/screens'),
    ]).then(([dashboards, servers, screens]) => {
      if (!live) return;
      setData({
        dashboards: Array.isArray(dashboards?.data?.dashboards) ? dashboards.data.dashboards : [],
        servers: Array.isArray(servers?.data?.servers) ? servers.data.servers : [],
        screens: Array.isArray(screens?.data?.screens) ? screens.data.screens : [],
      });
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open]);

  const items = useMemo(() => (data ? buildItems(data) : []), [data]);
  const results = useMemo(() => searchPalette(items, query, 40), [items, query]);

  useEffect(() => {
    setActive(current => Math.min(current, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = useCallback((item: PaletteItem) => {
    onOpenChange(false);
    router.push(item.href);
  }, [onOpenChange, router]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length) setActive(current => (current + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActive(current => (current - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[active];
      if (item) choose(item);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        className="gap-0 p-0 sm:top-[15%] sm:-translate-y-0 sm:p-0"
        onOpenAutoFocus={event => { event.preventDefault(); document.getElementById('palette-input')?.focus(); }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Find and open dashboards, servers, settings pages and widget pages.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border px-3 pr-12">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            id="palette-input"
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search dashboards, servers, settings…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            className="h-12 border-0 bg-transparent px-0 shadow-none focus-visible:border-0 focus-visible:ring-0"
          />
        </div>

        <div id="palette-results" role="listbox" aria-label="Search results" className="max-h-[min(60dvh,28rem)] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {loading ? 'Loading…' : query.trim() ? `No matches for “${query.trim()}”` : 'Nothing to search yet.'}
            </p>
          ) : (
            results.map((item, index) => {
              const Icon = KIND_ICON[item.kind];
              const selected = index === active;
              return (
                <div
                  key={item.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors',
                    selected ? 'bg-accent text-accent-foreground' : 'text-foreground'
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span aria-hidden>↑↓</span> navigate · <span aria-hidden>Enter</span> open · <span aria-hidden>Esc</span> close
        </div>
      </DialogContent>
    </Dialog>
  );
}
