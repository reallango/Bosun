'use client';

import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {}
});

// Helper function that ALWAYS works for redirect
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  // Don't redirect if already on login or setup pages
  if (path === '/login' || path === '/setup') return;
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

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}