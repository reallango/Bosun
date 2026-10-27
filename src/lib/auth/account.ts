/** Helpers for the "My account" routes (/api/auth/account*). */
import type { NextRequest } from 'next/server';
import { verifyPassword } from '@/lib/auth/password';
import { logAudit } from '@/lib/audit/logger';
import { fail } from '@/lib/api/response';
import { isSmtpEnabled } from '@/lib/mail';
import { clientIp, type AuthUser } from './session';
import { accountLimiter } from './mfa';
import { parseBackupHashes } from './codes';

/** Responses carrying secrets or account data must not be cached. */
export const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function accountView(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || '',
    email: user.email || '',
    role: user.role,
    mfa_method: user.mfa_method,
    backup_codes_remaining: user.mfa_method === 'none' ? 0 : parseBackupHashes(user.mfa_backup_codes).length,
    smtp_enabled: await isSmtpEnabled(),
    password_changed_at: user.password_changed_at,
  };
}

/**
 * Verify the user's current password (rate limited per user). Returns an
 * error response, or null when the password is right.
 */
export async function checkCurrentPassword(request: NextRequest, user: AuthUser, password: unknown, purpose: string) {
  const limit = accountLimiter.check(user.id);
  if (!limit.allowed) return fail('Too many attempts, try again later', 429, 'RATE_LIMITED');
  const pw = typeof password === 'string' ? password : '';
  if (pw && (await verifyPassword(pw, user.password_hash))) return null;
  accountLimiter.record(user.id);
  await logAudit({ userId: user.id, action: 'auth.password_check_failed', status: 'failure', ipAddress: clientIp(request), details: `${purpose}: wrong current password` });
  return fail('Current password is incorrect', 403, 'INVALID_PASSWORD');
}

/** Count a failed code confirmation against the per-user limit. */
export function checkCodeLimit(user: AuthUser) {
  const limit = accountLimiter.check(user.id);
  return limit.allowed ? null : fail('Too many attempts, try again later', 429, 'RATE_LIMITED');
}

export function recordCodeFailure(user: AuthUser) {
  accountLimiter.record(user.id);
}
