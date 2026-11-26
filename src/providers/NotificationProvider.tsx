'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

export interface Notification {
  id: string;
  /** What raised it: alert, widget_update, widget_upgraded, ... */
  kind: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  /** In-app page to open when clicked. */
  link: string | null;
  /** access_request notices: the request to approve or deny. */
  request_id?: string | null;
  read: boolean;
  /** Hidden from the bell; the Activity page still lists it. */
  dismissed?: boolean;
  created_at: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  fetchNotifications: () => Promise<void>;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

const REFRESH_MS = 60_000;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchNotifications = useCallback(async () => {
    if (!loaded) setLoading(true);
    try {
      const res = await fetchWithAuth('/api/notifications');
      const json = await readJson<{ data?: { notifications?: Notification[] } }>(res);
      setNotifications(json?.data?.notifications || []);
      setLoaded(true);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [loaded]);

  // Keep the bell current while the tab is visible.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void fetchNotifications(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchNotifications]);

  const markAsRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    try {
      await fetchWithAuth(`/api/notifications/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true })
      });
    } catch (err) {
      console.error('Failed to mark as read:', err);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    try {
      await fetchWithAuth('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true })
      });
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    try {
      const res = await fetchWithAuth(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) setNotifications(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to dismiss notification:', err);
    }
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, loading, fetchNotifications, markAsRead, markAllAsRead, dismiss }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return context;
}
