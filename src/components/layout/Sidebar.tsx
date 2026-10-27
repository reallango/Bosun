'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  Bell,
  Puzzle,
  Database,
  FileClock,
  House,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Server as ServerIcon,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';
import { ensureArray } from '@/lib/api/ensureArray';
import { useShell } from './ShellContext';

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
  { href: '/settings/cluster', label: 'Cluster', icon: Network },
  { href: '/settings/database', label: 'Database', icon: Database },
  { href: '/settings/alerts', label: 'Alerts', icon: Bell },
  { href: '/settings/custom-widgets', label: 'Custom Widgets', icon: Puzzle },
  { href: '/settings/audit-log', label: 'Audit Log', icon: FileClock },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

function useNavData() {
  const [servers, setServers] = useState<Server[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);

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
  }, []);

  return { servers, dashboards: dashboards.filter(d => d.type === 'custom') };
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
  const { servers, dashboards } = useNavData();

  return (
    <nav
      className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2 py-2"
      aria-label="Main navigation"
      onClick={e => {
        if (onNavigate && (e.target as HTMLElement).closest('a')) onNavigate();
      }}
    >
      {MAIN_NAV.map(item => (
        <NavLink
          key={item.href}
          href={item.href}
          label={item.label}
          icon={item.icon}
          active={isActive(pathname, item.href, item.exact)}
          collapsed={collapsed}
        />
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

      {dashboards.length > 0 && (
        <>
          <SectionLabel collapsed={collapsed}>Dashboards</SectionLabel>
          {dashboards.map(d => (
            <NavLink
              key={d.id}
              href={`/dashboards/${d.id}`}
              label={d.name}
              icon={LayoutDashboard}
              active={isActive(pathname, `/dashboards/${d.id}`)}
              collapsed={collapsed}
            />
          ))}
        </>
      )}

      <SectionLabel collapsed={collapsed}>Settings</SectionLabel>
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
    </nav>
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
        <div className={cn('flex h-14 items-center border-b border-sidebar-border px-3', collapsed && 'justify-center px-0')}>
          <Brand collapsed={collapsed} />
        </div>
        <SidebarNav collapsed={collapsed} />
        <div className={cn('border-t border-sidebar-border p-2', collapsed && 'flex justify-center')}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
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
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
