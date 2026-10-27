/**
 * Request a password reset link. POST { username? , email? }
 *
 * Always answers 200 with the same message, whether or not the account exists
 * (no user enumeration); the email is sent in the background so timing does
 * not tell either. A link is emailed only when the user exists, is enabled,
 * has an email address and SMTP is enabled. Rate limited per IP, except for a
 * signed-in admin (the Users page may call this with { username }).
 */
import { NextRequest, NextResponse } from 'next/server';
import { isNoQuorumError } from '@/lib/db/rqlite-client';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { logAudit } from '@/lib/audit/logger';
import { clientIp, findUserByEmail, findUserByUsername, type AuthUser } from '@/lib/auth/session';
import { createResetToken, forgotLimiter, RESET_TTL_MS } from '@/lib/auth/password-reset';
import { appBaseUrl, isSmtpEnabled, sendMail, simpleEmail } from '@/lib/mail';

const MESSAGE = 'If an account with that name or address exists and has an email address, a reset link has been sent. It is valid for 30 minutes.';

async function adminId(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get('access_token')?.value;
  if (!token) return null;
  const p = await verifyAccessToken(token);
  return p?.role === 'admin' ? p.userId : null;
}

async function sendResetEmail(user: AuthUser, link: string): Promise<void> {
  const body = simpleEmail({
    title: 'Reset your Bosun password',
    paragraphs: [
      `Hello ${user.display_name || user.username},`,
      `A password reset was requested for the Bosun account "${user.username}". Use the link below to choose a new password. It expires in ${RESET_TTL_MS / 60000} minutes and works once.`,
    ],
    link: { href: link, label: 'Choose a new password' },
    footer: 'If you did not request this, ignore this email; your password stays unchanged.',
  });
  await sendMail({ to: user.email as string, subject: '[Bosun] Password reset', ...body });
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const admin = await adminId(request);
    if (!admin && !forgotLimiter.consume(ip).allowed) {
      return NextResponse.json({ error: { message: 'Too many requests, try again later', code: 'RATE_LIMITED' } }, { status: 429 });
    }
    const body = await request.json().catch(() => ({}));
    const username = typeof body?.username === 'string' ? body.username.trim().slice(0, 254) : '';
    const email = typeof body?.email === 'string' ? body.email.trim().slice(0, 254) : '';

    let user: AuthUser | null = null;
    if (username) user = await findUserByUsername(username);
    if (!user && (email || username.includes('@'))) user = await findUserByEmail(email || username);

    let outcome = 'no matching account';
    if (user) {
      if (user.disabled) outcome = 'account disabled';
      else if (!user.email) outcome = 'account has no email address';
      else if (!(await isSmtpEnabled())) outcome = 'email (SMTP) is not enabled';
      else {
        const token = await createResetToken(user.id, ip);
        const link = `${await appBaseUrl(request)}/reset-password?token=${encodeURIComponent(token)}`;
        outcome = 'reset link emailed';
        const target = user;
        sendResetEmail(target, link).catch(async err => {
          console.error('[auth] sending password reset email failed:', err instanceof Error ? err.message : err);
          await logAudit({ userId: target.id, action: 'auth.password_reset_request', status: 'failure', ipAddress: ip, details: 'Sending the reset email failed' });
        });
      }
    }
    await logAudit({
      userId: user?.id ?? admin ?? undefined,
      action: 'auth.password_reset_request',
      status: outcome === 'reset link emailed' ? 'success' : 'failure',
      ipAddress: ip,
      details: `${admin ? 'Requested by an admin; ' : ''}${outcome}${user ? '' : ` (${(username || email).slice(0, 100)})`}`,
    });
    return NextResponse.json({ data: { message: MESSAGE } });
  } catch (error) {
    if (isNoQuorumError(error)) {
      return NextResponse.json({ error: { message: error.message, code: error.code } }, { status: 503 });
    }
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
