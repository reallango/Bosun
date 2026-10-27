'use client';

import { LogOut, Menu, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';
import { useAuth } from '@/hooks/useAuth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { NotificationBell } from './NotificationBell';
import { Breadcrumb } from './Breadcrumb';
import { useShell } from './ShellContext';

interface HeaderProps {
  title: string;
  /** Label to use for the last breadcrumb segment (e.g. a dashboard name instead of its id). */
  currentLabel?: string;
}

const iconButton =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const THEMES = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const;

export default function Header({ title, currentLabel }: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const { setMobileOpen } = useShell();

  const ThemeIcon = THEMES.find(t => t.id === theme)?.icon ?? Monitor;

  const cycleTheme = () => {
    const order = ['system', 'light', 'dark'] as const;
    setTheme(order[(order.indexOf(theme) + 1) % order.length]);
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.error('Logout error:', err);
      window.location.href = '/login';
    }
  };

  return (
    <header
      className={cn(
        'sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70',
        'pt-[env(safe-area-inset-top)]'
      )}
    >
      <div className="flex h-14 items-center gap-2 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] sm:gap-3 sm:px-4 xl:px-6">
        <button
          type="button"
          className={cn(iconButton, 'md:hidden')}
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
        >
          <Menu className="size-5" />
        </button>

        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="hidden md:block">
            <Breadcrumb currentLabel={currentLabel ?? title} />
          </div>
          <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">{title}</h1>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            onClick={cycleTheme}
            className={cn(iconButton, 'hidden xs:inline-flex')}
            aria-label={`Theme: ${theme}. Switch theme`}
            title={`Theme: ${theme}`}
          >
            <ThemeIcon className="size-[18px]" />
          </button>
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={iconButton} aria-label="User menu">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary">
                  {user?.username ? user.username.slice(0, 2) : <UserRound className="size-4" />}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel className="text-foreground">
                <div className="truncate text-sm font-medium">{user?.username ?? 'Signed in'}</div>
                {user?.role && <div className="text-xs font-normal capitalize text-muted-foreground">{user.role}</div>}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              {THEMES.map(t => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={() => setTheme(t.id)}
                  className={cn(theme === t.id && 'bg-accent/60 font-medium')}
                  aria-checked={theme === t.id}
                  role="menuitemradio"
                >
                  <t.icon />
                  {t.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleLogout}>
                <LogOut />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
