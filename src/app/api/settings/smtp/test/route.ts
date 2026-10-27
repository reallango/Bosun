/**
 * POST { to } -> sends a test email with the saved SMTP settings (also while
 * email is still disabled, so it can be verified before enabling). Admin only.
 * On failure answers 502 with the SMTP error text.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { sendMail, simpleEmail } from '@/lib/mail';
import { isValidEmail } from '@/lib/collect/recipients';
import { RateLimiter } from '@/lib/utils/rate-limiter';

const limiter = new RateLimiter({ maxAttempts: 10, windowMs: 10 * 60 * 1000, lockoutMs: 0 });

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  try {
    const b = await request.json().catch(() => null) as { to?: unknown } | null;
    const to = typeof b?.to === 'string' ? b.to.trim() : '';
    if (!isValidEmail(to)) return fail('Enter a valid recipient address');
    if (!limiter.consume(auth.userId).allowed) return fail('Too many test emails, try again later', 429, 'RATE_LIMITED');
    const body = simpleEmail({
      title: 'Bosun test email',
      paragraphs: ['This is a test message from Bosun. Outgoing email is working.'],
      footer: `Sent by ${auth.username} at ${new Date().toISOString()}`,
    });
    try {
      await sendMail({ to, subject: '[Bosun] Test email', ...body }, { ignoreEnabled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logAudit({ userId: auth.userId, action: 'config.smtp_test', category: 'config', status: 'failure', details: message.slice(0, 500) });
      return fail(`Sending failed: ${message}`, 502, 'SMTP_ERROR');
    }
    await logAudit({ userId: auth.userId, action: 'config.smtp_test', category: 'config', status: 'success', details: `Test email sent to ${to}` });
    return ok({ sent: true });
  } catch (error) {
    return failFrom(error);
  }
}
