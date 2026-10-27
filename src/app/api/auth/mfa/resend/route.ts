/**
 * Resend the emailed sign-in code. POST { challenge_id } -> 200 { data: { email_sent } }.
 * The challenge keeps its attempt count; the code and expiry are renewed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isNoQuorumError } from '@/lib/db/rqlite-client';
import { clientIp, findUserById } from '@/lib/auth/session';
import { getChallenge, challengeUsable, replaceChallengeCode, sendCodeEmail, emailCodeLimiter } from '@/lib/auth/mfa';
import { numericCode } from '@/lib/auth/codes';

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const body = await request.json().catch(() => ({}));
    if (!emailCodeLimiter.consume(ip).allowed) {
      return NextResponse.json({ error: { message: 'Too many codes requested, try again later', code: 'RATE_LIMITED' } }, { status: 429 });
    }
    const challenge = await getChallenge(typeof body?.challenge_id === 'string' ? body.challenge_id : '');
    if (!challengeUsable(challenge) || challenge.method !== 'email') {
      return NextResponse.json({ error: { message: 'This sign-in attempt has expired. Sign in again.', code: 'CHALLENGE_EXPIRED' } }, { status: 401 });
    }
    const user = await findUserById(challenge.user_id);
    if (!user || user.disabled || user.mfa_method !== 'email') {
      return NextResponse.json({ error: { message: 'This sign-in attempt has expired. Sign in again.', code: 'CHALLENGE_EXPIRED' } }, { status: 401 });
    }
    const code = numericCode();
    await replaceChallengeCode(challenge, code);
    let sent = true;
    try {
      await sendCodeEmail(user, code, 'login');
    } catch (err) {
      console.error('[auth] resending sign-in code failed:', err instanceof Error ? err.message : err);
      sent = false;
    }
    return NextResponse.json({ data: { email_sent: sent } });
  } catch (error) {
    if (isNoQuorumError(error)) {
      return NextResponse.json({ error: { message: error.message, code: error.code } }, { status: 503 });
    }
    console.error('MFA resend error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
