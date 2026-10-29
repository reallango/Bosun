'use client';

import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  username: string;
  role: string;
  /** What the user may do and where: permission id -> '*' (every server) or the server ids it covers. */
  permissions?: Record<string, '*' | string[]>;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** May the user do `permission` (on `serverId`, when the action targets a server)? */
  can: (permission: string, serverId?: string | null) => boolean;
  /** May the user do `permission` on at least one server (or system-wide)? For showing a page or a menu. */
  canAny: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
  can: () => false,
  canAny: () => false,
});

// Helper function that ALWAYS works for redirect
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  // Don't redirect if already on login or setup pages
  if (path === '/login' || path === '/setup' || path === '/forgot-password' || path === '/reset-password') return;
  // Use window.location.href - more reliable than router.push
  window.location.href = '/login';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      // 1. Try to get current user
      let res = await fetch('/api/auth/me');

      // 2. If unauthorized, attempt token refresh
      if (res.status === 401) {
        const refreshRes = await fetch('/api/auth/refresh', { method: 'POST' });

        if (refreshRes.ok) {
          // Retry with new access token
          res = await fetch('/api/auth/me');
        } else {
          // Refresh failed - force redirect to login
          setUser(null);
          setLoading(false);
          redirectToLogin();
          return;
        }
      }

      // 3. Parse the response
      const data = await res.json();
      if (res.ok && data.data?.user) {
        setUser(data.data.user);
      } else {
        setUser(null);
        redirectToLogin();
      }
    } catch {
      setUser(null);
      setLoading(false);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    redirectToLogin();
  };

  useEffect(() => {
    refresh();
  }, []);

  // Loading state shows spinner
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
      </div>
    );
  }

  // The UI only shows controls; the API enforces permissions on its own, so a stale map is never a security issue.
  const can = (permission: string, serverId?: string | null) => {
    if (!user) return false;
    if (user.role === 'admin') return true;   // Full access holds every permission
    const where = user.permissions?.[permission];
    if (!where) return false;
    if (where === '*') return true;
    return !!serverId && where.includes(serverId);
  };
  const canAny = (permission: string) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const where = user.permissions?.[permission];
    return !!where && (where === '*' || where.length > 0);
  };

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout, can, canAny }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}