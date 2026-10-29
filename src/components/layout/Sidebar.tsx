'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  Bell,
  Puzzle,
  Database,
  FileClock,
  House,
  KeyRound,
  KeySquare,
  ShieldCheck,
  LayoutDashboard,
  LineChart,
  Network,
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Check,
  Pencil,
  Server as ServerIcon,
  Settings,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { ensureArray } from '@/lib/api/ensureArray';
import { useShell } from './ShellContext';
import { useAuth } from '@/hooks/useAuth';
import { DASHBOARDS_CHANGED, notifyDashboardsChanged } from '@/lib/dashboards/events';
import { DashboardNameDialog } from '@/components/dashboard/DashboardNameDialog';
import { EditableDashboardRow } from './EditableDashboardRow';

interface Server {
  id: string;
  name: string;
  hostname: string;
  is_online: number | boolean;
  /** false = monitoring paused (shown as a yellow dot). */
  poll_enabled?: boolean;
}

interface Dashboard {
  id: string;
  name: string;
  type: string;
  server_id: string | null;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { href: '/', label: 'Home', icon: House, exact: true },
  { href: '/stats', label: 'Statistics', icon: LineChart },
];

const SETTINGS_NAV: NavItem[] = [
  { href: '/settings', label: 'General', icon: Settings, exact: true },
  { href: '/settings/servers', label: 'Servers', icon: ServerIcon },
  { href: '/settings/ssh-keys', label: 'SSH Keys', icon: KeyRound },
  { href: '/settings/users', label: 'Users', icon: Users },
  { href: '/settings/permissions', label: 'Permissions', icon: ShieldCheck },
  { href: '/settings/api-access', label: 'API Access', icon: KeySquare },
  { href: '/settings/cluster', label: 'Cluster', icon: Network },
  { href: '/settings/database', label: 'Database', icon: Database },
  { href: '/settings/alerts', label: 'Alerts', icon: Bell },
  { href: '/settings/custom-widgets', label: 'Custom Widgets', icon: Puzzle },
  { href: '/settings/audit-log', label: 'Audit Log', icon: FileClock },
  { href: '/settings/account', label: 'My Account', icon: UserCog },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

function useNavData() {
  const [servers, setServers] = useState<Server[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  // Bumped when a dashboard is created, renamed or deleted elsewhere in the app.
  const [dashboardsVersion, setDashboardsVersion] = useState(0);

  useEffect(() => {
    const bump = () => setDashboardsVersion(v => v + 1);
    window.addEventListener(DASHBOARDS_CHANGED, bump);
    return () => window.removeEventListener(DASHBOARDS_CHANGED, bump);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/api/servers')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(r => readJson<any>(r))
      .then(j => {
        if (!cancelled) setServers(ensureArray<Server>(j?.data?.servers ?? j?.servers));
      })
      .catch(err => {
        console.error('Failed to load servers', err);
        if (!cancelled) setServers([]);
      });
    fetchWithAuth('/api/dashboards')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(r => readJson<any>(r))
      .then(j => {
        if (!cancelled) setDashboards(ensureArray<Dashboard>(j?.data?.dashboards ?? j?.dashboards));
      })
      .catch(err => {
        console.error('Failed to load dashboards', err);
        if (!cancelled) setDashboards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardsVersion]);

  return { servers, dashboards: dashboards.filter(d => d.type === 'custom'), setDashboards };
}

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="mx-auto my-2 h-px w-6 bg-sidebar-border" aria-hidden />;
  return (
    <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted/80">
      {children}
    </div>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  leading,
}: {
  href: string;
  label: string;
  icon?: LucideIcon;
  active: boolean;
  collapsed: boolean;
  leading?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-sidebar-accent text-white'
          : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white'
      )}
    >
      {leading ?? (Icon && <Icon className="size-4 shrink-0" aria-hidden />)}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

function SidebarNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const { servers, dashboards, setDashboards } = useNavData();
  const { can } = useAuth();
  const canEdit = can('dashboards.edit');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [orderError, setOrderError] = useState('');

  // Move a custom dashboard one place up or down and save the new order.
  const moveDashboard = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= dashboards.length) return;
    const next = [...dashboards];
    [next[index], next[target]] = [next[target], next[index]];
    setDashboards(prev => [...prev.filter(d => d.type !== 'custom'), ...next]);
    setOrderError('');
    try {
      const res = await fetchWithAuth('/api/dashboards', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: next.map(d => d.id) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message || `HTTP ${res.status}`);
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : 'Could not save the order');
      notifyDashboardsChanged();
    }
  };

  return (
    <nav
      className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2 py-2"
      aria-label="Main navigation"
      onClick={e => {
        if (onNavigate && (e.target as HTMLElement).closest('a')) onNavigate();
      }}
    >
      {MAIN_NAV.map(item => (
        <div key={item.href} className="space-y-0.5">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NavLink
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(pathname, item.href, item.exact)}
                collapsed={collapsed}
              />
            </div>
            {item.href === '/' && canEdit && !collapsed && (
              <button
                type="button"
                onClick={() => setEditing(e => !e)}
                aria-pressed={editing}
                aria-label={editing ? 'Finish editing dashboards' : 'Edit dashboards'}
                title={editing ? 'Done' : 'Edit dashboards'}
                className={cn(
                  'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  editing ? 'bg-primary text-primary-foreground' : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white'
                )}
              >
                {editing ? <Check className="size-4" aria-hidden /> : <Pencil className="size-4" aria-hidden />}
              </button>
            )}
          </div>
          {/* Custom dashboards live under Home. */}
          {item.href === '/' && (dashboards.length > 0 || editing) && (
            <div className={cn('space-y-0.5', !collapsed && 'ml-4 border-l border-sidebar-border pl-2')}>
              {editing && !collapsed ? (
                <>
                  {dashboards.map((d, i) => (
                    <EditableDashboardRow
                      key={d.id}
                      name={d.name}
                      isFirst={i === 0}
                      isLast={i === dashboards.length - 1}
                      onRename={() => setRenaming({ id: d.id, name: d.name })}
                      onMove={dir => moveDashboard(i, dir)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex min-h-9 w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">Add dashboard</span>
                  </button>
                  {orderError && <p role="alert" className="px-3 text-xs text-destructive">{orderError}</p>}
                </>
              ) : (
                dashboards.map(d => (
                  <NavLink
                    key={d.id}
                    href={`/dashboards/${d.id}`}
                    label={d.name}
                    icon={LayoutDashboard}
                    active={isActive(pathname, `/dashboards/${d.id}`)}
                    collapsed={collapsed}
                  />
                ))
              )}
            </div>
          )}
        </div>
      ))}

      <SectionLabel collapsed={collapsed}>Servers</SectionLabel>
      {servers.map(s => (
        <NavLink
          key={s.id}
          href={`/servers/${s.id}`}
          label={s.name}
          active={isActive(pathname, `/servers/${s.id}`)}
          collapsed={collapsed}
          leading={
            collapsed ? (
              <span className="relative flex size-6 items-center justify-center rounded bg-sidebar-accent text-[11px] font-semibold uppercase text-sidebar-foreground">
                {s.name.slice(0, 2)}
                <span
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar',
                    s.poll_enabled === false ? 'bg-yellow-500' : s.is_online ? 'bg-green-500' : 'bg-gray-500'
                  )}
                />
              </span>
            ) : (
              <span
                className={cn('ml-1 mr-1 size-2 shrink-0 rounded-full', s.poll_enabled === false ? 'bg-yellow-500' : s.is_online ? 'bg-green-500' : 'bg-gray-500')}
                aria-label={s.poll_enabled === false ? 'not monitored' : s.is_online ? 'online' : 'offline'}
              />
            )
          }
        />
      ))}
      <NavLink
        href="/settings/servers/new"
        label="Add Server"
        icon={Plus}
        active={pathname === '/settings/servers/new'}
        collapsed={collapsed}
      />

      <DashboardNameDialog open={creating} onOpenChange={setCreating} onSaved={d => router.push(`/dashboards/${d.id}`)} />
      <DashboardNameDialog
        open={!!renaming}
        onOpenChange={open => !open && setRenaming(null)}
        dashboard={renaming ?? undefined}
      />
    </nav>
  );
}

/** Settings pinned to the bottom of the sidebar; the full menu opens upward on click. */
function SettingsMenu({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname() || '/';
  const [open, setOpen] = useState(false);
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');

  return (
    <div
      className="border-t border-sidebar-border px-2 py-2"
      onClick={e => {
        if (onNavigate && (e.target as HTMLElement).closest('a')) onNavigate();
      }}
    >
      {open && (
        <div id="settings-menu" className="mb-0.5 max-h-[50vh] space-y-0.5 overflow-y-auto overflow-x-hidden">
          {SETTINGS_NAV.map(item => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(pathname, item.href, item.exact) && !(item.href === '/settings/servers' && pathname === '/settings/servers/new')}
              collapsed={collapsed}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="settings-menu"
        aria-label={collapsed ? 'Settings' : undefined}
        title={collapsed ? 'Settings' : undefined}
        className={cn(
          'flex min-h-9 w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          collapsed && 'justify-center px-0',
          inSettings && !open ? 'text-white' : 'text-sidebar-muted',
          'hover:bg-sidebar-accent/60 hover:text-white'
        )}
      >
        <Settings className="size-4 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-left">Settings</span>
            {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronUp className="size-4 shrink-0" aria-hidden />}
          </>
        )}
      </button>
    </div>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/"
      className={cn('flex items-center gap-2 font-bold tracking-tight text-white', collapsed && 'justify-center')}
      aria-label="Bosun home"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground">
        B
      </span>
      {!collapsed && <span className="text-lg">Bosun</span>}
    </Link>
  );
}

/** Double chevron: points left to collapse the rail, right to expand it. */
function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
    </button>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useShell();

  // Close the mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  return (
    <>
      {/* Desktop / tablet: sticky rail */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex',
          'transition-[width] duration-200 motion-reduce:transition-none',
          'pl-[env(safe-area-inset-left)]',
          collapsed ? 'w-16' : 'w-60 2xl:w-64'
        )}
        aria-label="Sidebar"
      >
        <div className={cn('flex h-14 items-center border-b border-sidebar-border px-3', collapsed ? 'justify-center px-0' : 'justify-between')}>
          <Brand collapsed={collapsed} />
          {!collapsed && <RailToggle collapsed={collapsed} onToggle={toggleCollapsed} />}
        </div>
        {collapsed && (
          <div className="flex justify-center border-b border-sidebar-border py-1.5">
            <RailToggle collapsed={collapsed} onToggle={toggleCollapsed} />
          </div>
        )}
        <SidebarNav collapsed={collapsed} />
        <SettingsMenu collapsed={collapsed} />
      </aside>

      {/* Phone: off-canvas drawer */}
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
          <DialogPrimitive.Content
            className={cn(
              'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-xl outline-none md:hidden',
              'pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]'
            )}
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Site navigation menu</DialogPrimitive.Description>
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-3">
              <Brand collapsed={false} />
              <DialogPrimitive.Close
                className="rounded-md p-2 text-sidebar-muted hover:bg-sidebar-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Close menu"
              >
                <X className="size-5" />
              </DialogPrimitive.Close>
            </div>
            <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
            <SettingsMenu collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
