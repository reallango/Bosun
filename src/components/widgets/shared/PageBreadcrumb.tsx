'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export interface Crumb {
  label: string;
  /** Where the crumb leads; the last one is the page itself and usually has none. */
  href?: string;
}

/** The trail above a full-page widget screen: a link back to its dashboard, then the screen's title. */
export function PageBreadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={`${item.href ?? 'current'}:${item.label}`} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
            {item.href ? (
              <Link href={item.href} className="min-w-0 truncate hover:text-foreground hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="min-w-0 truncate font-medium text-foreground">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
