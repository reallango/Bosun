'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  title: string;
  href: string;
  icon?: string;
}

const mainNav: NavItem[] = [
  { title: 'Home', href: '/' },
  { title: 'Servers', href: '/settings/servers' },
  { title: 'SSH Keys', href: '/settings/ssh-keys' },
  { title: 'Cluster', href: '/settings/cluster' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="w-64 h-screen bg-gray-900 text-white flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <Link href="/" className="text-xl font-bold">Bosun</Link>
      </div>
      <nav className="flex-1 p-4 space-y-1">
        {mainNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'block px-3 py-2 rounded-md text-sm transition-colors',
              pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            )}
          >
            {item.title}
          </Link>
        ))}
      </nav>
    </div>
  );
}