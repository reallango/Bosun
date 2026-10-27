/**
 * Complete a password reset. POST { token, password }
 *  -> 200 { data: { reset: true } }: new hash, password_changed_at, token
 *     marked used, all of the user's sessions deleted (sign in again).
 *  -> 400 INVALID_TOKEN (unknown, used or expired) / WEAK_PASSWORD, 429 RATE_LIMITED
 * MFA stays as configured; the next sign-in still asks for the second factor.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rqlite, isNoQuorumError } from '@/lib/db/rqlite-client';
import { hashPassword } from '@/lib/auth/password';
import { logAudit } from '@/lib/audit/logger';
import { clientIp, findUserById } from '@/lib/auth/session';
import { findValidReset, consumeReset, passwordProblem, resetLimiter } from '@/lib/auth/password-reset';

const INVALID = { error: { message: 'This reset link is invalid or has expired. Request a new one.', code: 'INVALID_TOKEN' } };

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const limit = resetLimiter.check(ip);
    if (!limit.allowed) {
      return NextResponse.json({ error: { message: 'Too many attempts, try again later', code: 'RATE_LIMITED' } }, { status: 429 });
    }
    const body = await request.json().catch(() => ({}));
    const problem = passwordProblem(body?.password);
    if (problem) return NextResponse.json({ error: { message: problem, code: 'WEAK_PASSWORD' } }, { status: 400 });

    const row = await findValidReset(body?.token);
    if (!row) {
      resetLimiter.record(ip);
      await logAudit({ action: 'auth.password_reset', status: 'failure', ipAddress: ip, details: 'Invalid or expired reset token' });
      return NextResponse.json(INVALID, { status: 400 });
    }
    const user = await findUserById(row.user_id);
    if (!user || user.disabled || !(await consumeReset(row))) {
      resetLimiter.record(ip);
      await logAudit({ userId: row.user_id, action: 'auth.password_reset', status: 'failure', ipAddress: ip, details: user?.disabled ? 'Account disabled' : 'Token already used' });
      return NextResponse.json(INVALID, { status: 400 });
    }
    const hash = await hashPassword(body.password);
    const now = new Date().toISOString();
    await rqlite.executeBatch([
      { sql: 'UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', params: [hash, now, now, user.id] },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [user.id] },
    ], { transaction: true });
    await logAudit({ userId: user.id, action: 'auth.password_reset', status: 'success', ipAddress: ip, details: 'Password reset via emailed link; all sessions signed out' });
    return NextResponse.json({ data: { reset: true } });
  } catch (error) {
    if (isNoQuorumError(error)) {
      return NextResponse.json({ error: { message: error.message, code: error.code } }, { status: 503 });
    }
    console.error('Reset password error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
