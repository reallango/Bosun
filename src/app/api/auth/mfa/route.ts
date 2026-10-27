/**
 * Login step 2. POST { challenge_id, code } where code is the TOTP code, the
 * emailed code, or a backup code.
 *  -> 200 { data: { user } } with session cookies (as a normal login)
 *  -> 401 INVALID_CODE { attempts_left }, 401 CHALLENGE_EXPIRED (start over),
 *     429 RATE_LIMITED, 503 NO_QUORUM
 */
import { NextRequest, NextResponse } from 'next/server';
import { isNoQuorumError } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { clientIp, findUserById, startSession } from '@/lib/auth/session';
import {
  getChallenge, challengeUsable, registerAttempt, markChallengeUsed, verifySecondFactor, mfaLimiter, MAX_CHALLENGE_ATTEMPTS,
} from '@/lib/auth/mfa';

const EXPIRED = { error: { message: 'This sign-in attempt has expired. Sign in again.', code: 'CHALLENGE_EXPIRED' } };

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const body = await request.json().catch(() => ({}));
    const challengeId = typeof body?.challenge_id === 'string' ? body.challenge_id : '';
    const code = typeof body?.code === 'string' ? body.code : '';

    const limit = mfaLimiter.check(ip);
    if (!limit.allowed) {
      const retryAfterSec = Math.ceil((limit.retryAfterMs ?? 60_000) / 1000);
      return NextResponse.json(
        { error: { message: `Too many attempts, try again in ${Math.ceil(retryAfterSec / 60)} min`, code: 'RATE_LIMITED' } },
        { status: 429, headers: { 'Retry-After': String(retryAfterSec) } });
    }

    const challenge = await getChallenge(challengeId);
    if (!challengeUsable(challenge) || !['totp', 'email'].includes(challenge.method)) {
      mfaLimiter.record(ip);
      return NextResponse.json(EXPIRED, { status: 401 });
    }
    const user = await findUserById(challenge.user_id);
    if (!user || user.disabled || user.mfa_method !== challenge.method) {
      mfaLimiter.record(ip);
      return NextResponse.json(EXPIRED, { status: 401 });
    }
    if (!(await registerAttempt(challenge))) {
      mfaLimiter.record(ip);
      return NextResponse.json(EXPIRED, { status: 401 });
    }

    const result = await verifySecondFactor(user, code, {
      challenge, method: challenge.method as 'totp' | 'email', preventReplay: true,
    });
    if (!result.ok) {
      mfaLimiter.record(ip);
      const attemptsLeft = Math.max(0, MAX_CHALLENGE_ATTEMPTS - (challenge.attempts + 1));
      await logAudit({ userId: user.id, action: 'auth.mfa_failed', details: `Invalid ${challenge.method} or backup code`, status: 'failure', ipAddress: ip });
      if (attemptsLeft === 0) return NextResponse.json(EXPIRED, { status: 401 });
      return NextResponse.json({ error: { message: 'Invalid code', code: 'INVALID_CODE', attempts_left: attemptsLeft } }, { status: 401 });
    }
    if (!(await markChallengeUsed(challenge, result.totpStep !== undefined ? `totp:${result.totpStep}` : undefined))) {
      return NextResponse.json(EXPIRED, { status: 401 });
    }
    if (result.via === 'backup') {
      await logAudit({ userId: user.id, action: 'auth.mfa_backup_code_used', status: 'success', ipAddress: ip });
    }
    return await startSession(request, user, `mfa: ${result.via}`);
  } catch (error) {
    if (isNoQuorumError(error)) {
      return NextResponse.json({ error: { message: error.message, code: error.code } }, { status: 503 });
    }
    console.error('MFA error:', error);
    await logAudit({ action: AuditActions.LOGIN_FAILED, details: 'MFA step failed with an internal error', status: 'failure' });
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
