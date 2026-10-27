'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

interface BreadcrumbItem {
  label: string;
  href: string;
}

// Path prefixes that have no index page of their own.
const NON_ROUTES = new Set(['/servers', '/dashboards']);

const ID_LIKE = /^[0-9a-f-]{16,}$/i;

function labelFor(part: string) {
  if (ID_LIKE.test(part)) return part.slice(0, 8) + '…';
  return part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
}

export function Breadcrumb({ currentLabel }: { currentLabel?: string }) {
  const pathname = usePathname() || '/';
  const paths = pathname.split('/').filter(Boolean);

  const items: BreadcrumbItem[] = [{ label: 'Home', href: '/' }];
  let currentPath = '';
  for (const part of paths) {
    currentPath += `/${part}`;
    items.push({ label: labelFor(part), href: currentPath });
  }
  if (currentLabel && items.length > 1) items[items.length - 1].label = currentLabel;
  // Only show ancestors; the page title already names the current page.
  const trail = items.slice(0, -1).filter(item => !NON_ROUTES.has(item.href));
  if (trail.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {trail.map((item, i) => (
          <li key={item.href} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 shrink-0" aria-hidden />}
            <Link href={item.href} className="truncate hover:text-foreground hover:underline">
              {item.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
