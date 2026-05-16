import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumb() {
  const pathname = usePathname();
  const paths = pathname.split('/').filter(Boolean);

  const items: BreadcrumbItem[] = [{ label: 'Home', href: '/' }];
  let currentPath = '';

  for (const part of paths) {
    currentPath += `/${part}`;
    items.push({
      label: part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' '),
      href: currentPath,
    });
  }

  return (
    <nav className="flex items-center gap-2 text-sm">
      {items.map((item, i) => (
        <span key={item.href || i} className="flex items-center gap-2">
          {i > 0 && <span className="text-gray-400">/</span>}
          {item.href && i < items.length - 1 ? (
            <Link href={item.href} className="text-gray-500 hover:text-gray-700">
              {item.label}
            </Link>
          ) : (
            <span className="text-gray-900 dark:text-gray-100">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}