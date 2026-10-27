'use client';

import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { readJson } from '@/lib/api/readJson';

export interface Account {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: string;
  mfa_method: 'none' | 'totp' | 'email';
  backup_codes_remaining: number;
  smtp_enabled: boolean;
  password_changed_at: string | null;
}

/** POST/PATCH/GET JSON to an account route; throws with the API's message. */
export async function accountApi<T>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'POST', body?: unknown): Promise<T> {
  const res = await fetchWithAuth(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await readJson<{ data?: T; error?: { message?: string } }>(res);
  if (!res.ok || json.data === undefined) throw new Error(json.error?.message || `Request failed (HTTP ${res.status})`);
  return json.data;
}

export const mfaAction = <T>(action: string, body: unknown = {}) => accountApi<T>(`/api/auth/account/mfa/${action}`, 'POST', body);
