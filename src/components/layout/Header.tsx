'use client';

import { useRouter } from 'next/navigation';
import { useTheme } from '@/providers/ThemeProvider';
import { NotificationBell } from './NotificationBell';

interface HeaderProps {
  title: string;
}

export default function Header({ title }: HeaderProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const cycleTheme = () => {
    const themes: ('system' | 'light' | 'dark')[] = ['system', 'light', 'dark'];
    const currentIndex = themes.indexOf(theme);
    const nextIndex = (currentIndex + 1) % themes.length;
    setTheme(themes[nextIndex]);
  };

  const getThemeIcon = () => {
    switch (theme) {
      case 'light': return '☀️';
      case 'dark': return '🌙';
      case 'system': return '💻';
    }
  };

  return (
    <header className="h-16 bg-white border-b border-gray-200 dark:bg-gray-800 dark:border-gray-700 flex items-center justify-between px-6">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{title}</h1>
      <div className="flex items-center gap-4">
        <button
          onClick={cycleTheme}
          className="text-lg hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md p-2 transition-colors"
          title={`Theme: ${theme}`}
        >
          {getThemeIcon()}
        </button>
        <NotificationBell />
        <button
          onClick={handleLogout}
          className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
        >
          Logout
        </button>
      </div>
    </header>
  );
}