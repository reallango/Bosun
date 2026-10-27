/**
 * Change the signed-in user's password. POST { current_password, new_password }
 * Signs out every other session of the user (this one stays signed in).
 */
import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, fail, internalError } from '@/lib/api/response';
import { hashPassword } from '@/lib/auth/password';
import { logAudit } from '@/lib/audit/logger';
import { hashToken } from '@/lib/auth/jwt';
import { clientIp, requireCookieUser } from '@/lib/auth/session';
import { checkCurrentPassword } from '@/lib/auth/account';
import { passwordProblem } from '@/lib/auth/password-reset';

export async function POST(request: NextRequest) {
  try {
    const user = await requireCookieUser(request);
    if (user instanceof NextResponse) return user;
    const b = await request.json().catch(() => ({}));
    const problem = passwordProblem(b?.new_password);
    if (problem) return fail(problem, 400, 'WEAK_PASSWORD');
    const denied = await checkCurrentPassword(request, user, b?.current_password, 'Password change');
    if (denied) return denied;
    if (b.new_password === b.current_password) return fail('The new password must differ from the current one', 400, 'WEAK_PASSWORD');

    const hash = await hashPassword(b.new_password);
    const now = new Date().toISOString();
    const refresh = request.cookies.get('refresh_token')?.value;
    await rqlite.executeBatch([
      { sql: 'UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', params: [hash, now, now, user.id] },
      refresh
        ? { sql: 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', params: [user.id, hashToken(refresh)] }
        : { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [user.id] },
    ], { transaction: true });
    await logAudit({ userId: user.id, action: 'auth.password_change', status: 'success', ipAddress: clientIp(request), details: 'Password changed; other sessions signed out' });
    return ok({ changed: true });
  } catch (error) {
    return internalError(error);
  }
}
