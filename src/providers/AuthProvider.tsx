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

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      let res = await fetch('/api/auth/me');

      // If unauthorized, try refreshing the token
      if (res.status === 401) {
        const refreshRes = await fetch('/api/auth/refresh', { method: 'POST' });

        if (refreshRes.ok) {
          // Retry with new access token
          res = await fetch('/api/auth/me');
        } else {
          // Refresh failed - go to login
          setUser(null);
          setLoading(false);
          if (typeof window !== 'undefined' &&
              !window.location.pathname.startsWith('/login') &&
              !window.location.pathname.startsWith('/setup')) {
            router.push('/login');
          }
          return;
        }
      }

      const data = await res.json();
      if (res.ok && data.data?.user) {
        setUser(data.data.user);
      } else {
        setUser(null);
        // Only redirect if we're not already on login/setup
        if (typeof window !== 'undefined' &&
            !window.location.pathname.startsWith('/login') &&
            !window.location.pathname.startsWith('/setup')) {
          router.push('/login');
        }
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    router.push('/login');
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}