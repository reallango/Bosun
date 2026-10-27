/**
 * The signed-in user's own account (cookie session only, never API keys).
 *
 * GET   -> { id, username, display_name, email, role, mfa_method,
 *            backup_codes_remaining, smtp_enabled, password_changed_at }
 * PATCH <- { display_name?, email?, current_password? }
 *          Changing the email address requires current_password.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, fail, internalError } from '@/lib/api/response';
import { logAudit } from '@/lib/audit/logger';
import { clientIp, requireCookieUser } from '@/lib/auth/session';
import { accountView, checkCurrentPassword, NO_STORE } from '@/lib/auth/account';
import { isValidEmail } from '@/lib/collect/recipients';

export async function GET(request: NextRequest) {
  try {
    const user = await requireCookieUser(request);
    if (user instanceof NextResponse) return user;
    return ok(await accountView(user), NO_STORE);
  } catch (error) {
    return internalError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await requireCookieUser(request);
    if (user instanceof NextResponse) return user;
    const b = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return fail('Expected a JSON body', 400, 'INVALID_BODY');
    const sets: string[] = [];
    const params: unknown[] = [];
    const changes: string[] = [];

    if (b.display_name !== undefined) {
      const name = typeof b.display_name === 'string' ? b.display_name.trim() : '';
      if (name.length > 100 || /[\r\n]/.test(name)) return fail('Display name must be at most 100 characters');
      if ((name || null) !== (user.display_name || null)) {
        sets.push('display_name = ?');
        params.push(name || null);
        changes.push('display name');
      }
    }
    if (b.email !== undefined) {
      const email = typeof b.email === 'string' ? b.email.trim() : '';
      if (email && !isValidEmail(email)) return fail('Enter a valid email address');
      if ((email || null) !== (user.email || null)) {
        if (!email && user.mfa_method === 'email') return fail('Email sign-in codes are on: turn off two-step verification before removing your address');
        const denied = await checkCurrentPassword(request, user, b.current_password, 'Email change');
        if (denied) return denied;
        sets.push('email = ?');
        params.push(email || null);
        changes.push('email');
      }
    }
    if (!sets.length) return ok(await accountView(user), NO_STORE);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    await rqlite.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, user.id]);
    await logAudit({ userId: user.id, action: 'auth.profile_update', status: 'success', ipAddress: clientIp(request), details: `Changed ${changes.join(' and ')}` });
    const fresh = await requireCookieUser(request);
    if (fresh instanceof NextResponse) return fresh;
    return ok(await accountView(fresh), NO_STORE);
  } catch (error) {
    return internalError(error);
  }
}
