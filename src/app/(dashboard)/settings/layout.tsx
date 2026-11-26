'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Header from '@/components/layout/Header';
import { cn } from '@/lib/utils';

interface SettingsNavItem {
  href: string;
  label: string;
  /** Only active on the exact path (the settings index). */
  exact?: boolean;
}

interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

// One list: adding a settings page is one line here. Order matches the URL tree.
const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'You',
    items: [
      { href: '/settings/account', label: 'Account' },
      { href: '/settings/ssh-keys', label: 'SSH keys' },
    ],
  },
  {
    label: 'Servers',
    items: [
      { href: '/settings/servers', label: 'Servers' },
      { href: '/settings/cluster', label: 'Cluster' },
      { href: '/settings/alerts', label: 'Alerts' },
    ],
  },
  {
    label: 'Access',
    items: [
      { href: '/settings/users', label: 'Users' },
      { href: '/settings/permissions', label: 'Permissions' },
      { href: '/settings/api-access', label: 'API access' },
      { href: '/settings/access-requests', label: 'Access requests' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/settings', label: 'General', exact: true },
      { href: '/settings/widgets', label: 'Widgets' },
      { href: '/settings/updates', label: 'Updates' },
      { href: '/settings/database', label: 'Database' },
      { href: '/settings/audit-log', label: 'Audit log' },
    ],
  },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

function SettingsNavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      {label}
    </Link>
  );
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/settings';
  const navRef = useRef<HTMLElement>(null);

  // On phones the navigation is a scroller; bring the current item into view.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.left < navRect.left || itemRect.right > navRect.right) {
      nav.scrollLeft += itemRect.left - navRect.left - nav.clientWidth / 2 + itemRect.width / 2;
    }
  }, [pathname]);

  return (
    <>
      <Header title="Settings" />
      <div className="page">
        <div className="mx-auto w-full max-w-7xl md:flex md:items-start md:gap-6 lg:gap-8">
          {/* Wide screens: a column; below md: a horizontal scroller. */}
          <nav
            ref={navRef}
            aria-label="Settings"
            className="mb-4 overflow-x-auto pb-1 md:sticky md:top-16 md:mb-0 md:w-40 md:shrink-0 md:overflow-visible md:pb-0"
          >
            <div className="flex items-center gap-2 md:flex-col md:items-stretch md:gap-5">
              {SETTINGS_NAV.map((group, i) => (
                <div key={group.label} className="flex shrink-0 items-center gap-2 md:block">
                  {i > 0 && <span aria-hidden className="h-5 w-px shrink-0 self-center bg-border md:hidden" />}
                  <h2 className="hidden text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:block md:px-2.5 md:pb-1">
                    {group.label}
                  </h2>
                  <ul className="flex items-center gap-1 md:flex-col md:items-stretch md:gap-0.5">
                    {group.items.map(item => (
                      <li key={item.href} className="shrink-0">
                        <SettingsNavLink
                          href={item.href}
                          label={item.label}
                          active={isActive(pathname, item.href, item.exact)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>

          <div className="min-w-0 flex-1 space-y-4 md:max-w-5xl sm:space-y-6">{children}</div>
        </div>
      </div>
    </>
  );
}
