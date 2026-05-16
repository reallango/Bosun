'use client';

import { useContext } from 'react';
import { AuthProvider, useAuth as useAuthContext } from '@/providers/AuthProvider';

export { AuthProvider };
export function useAuth() {
  return useAuthContext();
}