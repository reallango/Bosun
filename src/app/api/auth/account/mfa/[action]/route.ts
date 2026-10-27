/**
 * Two-step verification for the signed-in user (cookie session only).
 * POST /api/auth/account/mfa/<action>:
 *
 *  totp-setup     {}                          -> { secret, otpauth_uri, qr_svg }  (pending until confirmed)
 *  totp-enable    { code }                    -> { backup_codes }
 *  email-start    {}                          -> { challenge_id }  (emails a code to the account address)
 *  email-enable   { challenge_id, code }      -> { backup_codes }
 *  backup-codes   { password }                -> { backup_codes }  (replaces the old ones)
 *  disable-start  {}                          -> { challenge_id }  (email method: emails a code)
 *  disable        { password, code, challenge_id? } -> { disabled: true }
 *
 * Enabling requires MFA to be off; to switch methods, disable first.
 * Backup codes are shown once; only their hashes are stored.
 */
import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, fail, internalError } from '@/lib/api/response';
import { logAudit } from '@/lib/audit/logger';
import { clientIp, requireCookieUser, type AuthUser } from '@/lib/auth/session';
import { checkCurrentPassword, checkCodeLimit, recordCodeFailure, NO_STORE } from '@/lib/auth/account';
import { generateTotpSecret, otpauthUri } from '@/lib/auth/totp';
import { generateBackupCodes } from '@/lib/auth/codes';
import {
  encryptTotpSecret, startEmailChallenge, getChallenge, challengeUsable, registerAttempt, markChallengeUsed,
  verifySecondFactor, emailCodeLimiter, type Challenge,
} from '@/lib/auth/mfa';
import { isSmtpEnabled } from '@/lib/mail';

type Body = Record<string, unknown>;

const MFA_ON = () => fail('Two-step verification is already on. Turn it off first to change the method.', 409, 'MFA_ENABLED');
const MFA_OFF = () => fail('Two-step verification is not on', 409, 'MFA_DISABLED');
const BAD_CODE = () => fail('Invalid or expired code', 400, 'INVALID_CODE');

async function audit(request: NextRequest, user: AuthUser, action: string, status: 'success' | 'failure', details: string) {
  await logAudit({ userId: user.id, action, status, ipAddress: clientIp(request), details });
}

/** Load and check an email challenge of this user (counting the attempt). */
async function claimChallenge(user: AuthUser, id: unknown, method: string): Promise<Challenge | null> {
  const c = await getChallenge(typeof id === 'string' ? id : '');
  if (!challengeUsable(c) || c.user_id !== user.id || c.method !== method) return null;
  return (await registerAttempt(c)) ? c : null;
}

async function storeBackupCodes(userId: string, extraSql: string) {
  const { codes, hashes } = generateBackupCodes();
  await rqlite.execute(`UPDATE users SET ${extraSql}mfa_backup_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(hashes), userId]);
  return codes;
}

async function totpSetup(user: AuthUser) {
  if (user.mfa_method !== 'none') return MFA_ON();
  const secret = generateTotpSecret();
  await rqlite.execute('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [encryptTotpSecret(secret), user.id]);
  const uri = otpauthUri(secret, user.username);
  const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return ok({ secret, otpauth_uri: uri, qr_svg: qrSvg }, NO_STORE);
}

async function totpEnable(request: NextRequest, user: AuthUser, b: Body) {
  if (user.mfa_method !== 'none') return MFA_ON();
  if (!user.totp_secret) return fail('Start the authenticator setup first', 400, 'NO_PENDING_SETUP');
  const limited = checkCodeLimit(user);
  if (limited) return limited;
  const r = await verifySecondFactor(user, String(b.code ?? ''), { method: 'totp', allowBackup: false });
  if (!r.ok) {
    recordCodeFailure(user);
    await audit(request, user, 'auth.mfa_enable', 'failure', 'Authenticator app: wrong confirmation code');
    return BAD_CODE();
  }
  const codes = await storeBackupCodes(user.id, "mfa_method = 'totp', totp_enabled = 1, ");
  await audit(request, user, 'auth.mfa_enable', 'success', 'Authenticator app (TOTP) enabled; backup codes issued');
  return ok({ backup_codes: codes }, NO_STORE);
}

async function emailStart(user: AuthUser, method: 'email_setup' | 'email_verify', purpose: 'setup' | 'verify') {
  if (!user.email) return fail('Add an email address to your account first', 400, 'NO_EMAIL');
  if (!(await isSmtpEnabled())) return fail('Email is not configured on this Bosun. Ask an administrator to set up SMTP.', 400, 'SMTP_DISABLED');
  if (!emailCodeLimiter.consume(`user:${user.id}`).allowed) return fail('Too many codes requested, try again later', 429, 'RATE_LIMITED');
  const { challenge, sent } = await startEmailChallenge(user, method, purpose);
  if (!sent) return fail('The code could not be emailed. Check the address, or ask an administrator to check the SMTP settings.', 502, 'SMTP_ERROR');
  return ok({ challenge_id: challenge.id }, NO_STORE);
}

async function emailEnable(request: NextRequest, user: AuthUser, b: Body) {
  if (user.mfa_method !== 'none') return MFA_ON();
  if (!user.email) return fail('Add an email address to your account first', 400, 'NO_EMAIL');
  const limited = checkCodeLimit(user);
  if (limited) return limited;
  const c = await claimChallenge(user, b.challenge_id, 'email_setup');
  const r = c ? await verifySecondFactor(user, String(b.code ?? ''), { method: 'email', challenge: c, allowBackup: false }) : { ok: false };
  if (!c || !r.ok || !(await markChallengeUsed(c))) {
    recordCodeFailure(user);
    await audit(request, user, 'auth.mfa_enable', 'failure', 'Email codes: wrong confirmation code');
    return BAD_CODE();
  }
  const codes = await storeBackupCodes(user.id, "mfa_method = 'email', totp_secret = NULL, totp_enabled = 0, ");
  await audit(request, user, 'auth.mfa_enable', 'success', 'Email sign-in codes enabled; backup codes issued');
  return ok({ backup_codes: codes }, NO_STORE);
}

async function regenerateBackupCodes(request: NextRequest, user: AuthUser, b: Body) {
  if (user.mfa_method === 'none') return MFA_OFF();
  const denied = await checkCurrentPassword(request, user, b.password, 'Backup codes');
  if (denied) return denied;
  const codes = await storeBackupCodes(user.id, '');
  await audit(request, user, 'auth.mfa_backup_codes', 'success', 'Backup codes regenerated');
  return ok({ backup_codes: codes }, NO_STORE);
}

async function disable(request: NextRequest, user: AuthUser, b: Body) {
  if (user.mfa_method === 'none') return MFA_OFF();
  const denied = await checkCurrentPassword(request, user, b.password, 'Disable two-step verification');
  if (denied) return denied;
  const limited = checkCodeLimit(user);
  if (limited) return limited;
  const code = String(b.code ?? '');
  let challenge: Challenge | null = null;
  if (user.mfa_method === 'email' && /^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    challenge = await claimChallenge(user, b.challenge_id, 'email_verify');
  }
  const r = await verifySecondFactor(user, code, { challenge });
  if (!r.ok || (challenge && !(await markChallengeUsed(challenge)))) {
    recordCodeFailure(user);
    await audit(request, user, 'auth.mfa_disable', 'failure', 'Wrong verification code');
    return BAD_CODE();
  }
  await rqlite.execute(
    "UPDATE users SET mfa_method = 'none', totp_secret = NULL, totp_enabled = 0, mfa_backup_codes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [user.id]);
  await audit(request, user, 'auth.mfa_disable', 'success', `Two-step verification (${user.mfa_method}) turned off${r.via === 'backup' ? ' using a backup code' : ''}`);
  return ok({ disabled: true });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  try {
    const user = await requireCookieUser(request);
    if (user instanceof NextResponse) return user;
    const { action } = await params;
    const b = ((await request.json().catch(() => ({}))) || {}) as Body;
    switch (action) {
      case 'totp-setup': return await totpSetup(user);
      case 'totp-enable': return await totpEnable(request, user, b);
      case 'email-start':
        if (user.mfa_method !== 'none') return MFA_ON();
        return await emailStart(user, 'email_setup', 'setup');
      case 'email-enable': return await emailEnable(request, user, b);
      case 'backup-codes': return await regenerateBackupCodes(request, user, b);
      case 'disable-start':
        if (user.mfa_method !== 'email') return fail('Only needed for email sign-in codes', 400);
        return await emailStart(user, 'email_verify', 'verify');
      case 'disable': return await disable(request, user, b);
      default: return fail('Unknown action', 404, 'NOT_FOUND');
    }
  } catch (error) {
    console.error('Account MFA error:', error);
    return internalError(error);
  }
}

