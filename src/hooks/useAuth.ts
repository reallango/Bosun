'use client';

import { useAuth as useAuthContext } from '@/providers/AuthProvider';

export function useAuth() {
  return useAuthContext();
}