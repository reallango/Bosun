/**
 * POST { username, password }
 *  -> 200 { data: { user } } with session cookies, or, when the account has
 *     MFA, 200 { data: { mfa_required: true, challenge_id, method, email_sent? } }
 *     without cookies; finish with POST /api/auth/mfa.
 *  -> 401 INVALID_CREDENTIALS, 403 ACCOUNT_DISABLED, 429 RATE_LIMITED, 503 NO_QUORUM
 */
import { NextRequest, NextResponse } from 'next/server';
import { isNoQuorumError } from '@/lib/db/rqlite-client';
import crypto from 'crypto';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { checkLoginRateLimit, recordLoginAttempt } from '@/lib/utils/rate-limiter';
import { clientIp, findUserByUsername, startSession } from '@/lib/auth/session';
import { createChallenge, startEmailChallenge } from '@/lib/auth/mfa';

let dummyHash: Promise<string> | undefined;

const INVALID ={ error: { message: 'Invalid username or password', code: 'INVALID_CREDENTIALS' } };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const ip = clientIp(request);

    const rateLimit = checkLoginRateLimit(ip);
    if (!rateLimit.allowed) {
      const retryAfterSec = Math.ceil((rateLimit.retryAfterMs ?? 60_000) / 1000);
      return NextResponse.json(
        { error: { message: `Too many attempts, try again in ${Math.ceil(retryAfterSec / 60)} min`, code: 'RATE_LIMITED' } },
        { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
      );
    }

    const user = username ? await findUserByUsername(username) : null;
    if (!user) {
      // Spend the same scrypt time as for a real account (no user enumeration by timing).
      dummyHash ??= hashPassword(crypto.randomUUID());
      await verifyPassword(password || 'x', await dummyHash).catch(() => false);
      recordLoginAttempt(ip);
      await logAudit({ action: AuditActions.LOGIN_FAILED, details: `Unknown user: ${username.slice(0, 100)}`, status: 'failure', ipAddress: ip });
      return NextResponse.json(INVALID, { status: 401 });
    }
    const valid = password ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) {
      recordLoginAttempt(ip);
      await logAudit({ userId: user.id, action: AuditActions.LOGIN_FAILED, status: 'failure', ipAddress: ip });
      return NextResponse.json(INVALID, { status: 401 });
    }
    if (user.disabled) {
      recordLoginAttempt(ip);
      await logAudit({ userId: user.id, action: AuditActions.LOGIN_FAILED, details: 'Account disabled', status: 'failure', ipAddress: ip });
      return NextResponse.json({ error: { message: 'This account cannot sign in. Contact an administrator.', code: 'ACCOUNT_DISABLED' } }, { status: 403 });
    }

    if (user.mfa_method === 'totp' || user.mfa_method === 'email') {
      if (user.mfa_method === 'totp') {
        const challenge = await createChallenge(user.id, 'totp');
        await logAudit({ userId: user.id, action: 'auth.mfa_challenge', details: 'totp', status: 'pending', ipAddress: ip });
        return NextResponse.json({ data: { mfa_required: true, challenge_id: challenge.id, method: 'totp' } });
      }
      const { challenge, sent } = await startEmailChallenge(user, 'email', 'login');
      await logAudit({ userId: user.id, action: 'auth.mfa_challenge', details: sent ? 'email code sent' : 'email code could not be sent', status: 'pending', ipAddress: ip });
      return NextResponse.json({ data: { mfa_required: true, challenge_id: challenge.id, method: 'email', email_sent: sent } });
    }

    return await startSession(request, user);
  } catch (error) {
    if (isNoQuorumError(error)) {
      return NextResponse.json({ error: { message: error.message, code: error.code } }, { status: 503 });
    }
    console.error('Login error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
