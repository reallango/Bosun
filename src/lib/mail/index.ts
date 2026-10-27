/**
 * Outgoing email for the web app: SMTP settings live in app_config (smtp.*),
 * the password encrypted with the master key. Transport code is shared with
 * the poller in lib/collect/mailer.js.
 */
import type { NextRequest } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';
import { createMailer, configFromValues, escapeHtml, SMTP_KEYS } from '@/lib/collect/mailer';

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  user: string;
  password: string;
  from: string;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

/** Raw smtp.* and app.url values from app_config. */
export async function readSmtpValues(): Promise<Record<string, string | null>> {
  const keys = [...SMTP_KEYS, 'app.url'];
  const r = await rqlite.query(
    `SELECT key, value FROM app_config WHERE key IN (${keys.map(() => '?').join(', ')})`, keys);
  const out: Record<string, string | null> = {};
  for (const row of r.values || []) out[String(row[0])] = row[1] == null ? null : String(row[1]);
  return out;
}

function decryptPassword(enc: string): string {
  return decrypt(enc, getMasterKey());
}

/**
 * Decrypted SMTP config, or null when email is disabled or not configured.
 * `ignoreEnabled` returns the saved settings even while disabled (for tests).
 */
export async function loadSmtpConfig(options: { ignoreEnabled?: boolean } = {}): Promise<SmtpConfig | null> {
  const values = await readSmtpValues();
  return configFromValues(values, decryptPassword, options) as SmtpConfig | null;
}

export async function isSmtpEnabled(): Promise<boolean> {
  try {
    return (await loadSmtpConfig()) !== null;
  } catch {
    return false;
  }
}

/** Send with the saved settings; throws when email is disabled or sending fails. */
export async function sendMail(msg: MailMessage, options: { ignoreEnabled?: boolean } = {}): Promise<void> {
  const cfg = await loadSmtpConfig(options);
  if (!cfg) throw new Error('Email (SMTP) is not enabled');
  const mailer = createMailer(cfg);
  try {
    await mailer.send(msg);
  } finally {
    mailer.close();
  }
}

/**
 * Base URL for links in emails: app.url when set, else the request's origin
 * (as seen through the reverse proxy). Setting app.url is recommended, since
 * the Host header is client-controlled.
 */
export async function appBaseUrl(request: NextRequest): Promise<string> {
  const values = await readSmtpValues().catch(() => ({} as Record<string, string | null>));
  const configured = (values['app.url'] || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(configured)) return configured;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || request.nextUrl.protocol.replace(/:$/, '');
  const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host') || request.nextUrl.host;
  return `${proto}://${host}`;
}

/** A plain-text + minimal HTML email: paragraphs, an optional button link and footer. */
export function simpleEmail(opts: { title: string; paragraphs: string[]; link?: { href: string; label: string }; code?: string; footer?: string }): { text: string; html: string } {
  const text = [
    opts.title,
    '',
    ...opts.paragraphs.flatMap(p => [p, '']),
    ...(opts.code ? [opts.code, ''] : []),
    ...(opts.link ? [`${opts.link.label}: ${opts.link.href}`, ''] : []),
    ...(opts.footer ? ['--', opts.footer] : []),
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 12px">${escapeHtml(opts.title)}</h2>
${opts.paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('\n')}
${opts.code ? `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${escapeHtml(opts.code)}</p>` : ''}
${opts.link ? `<p><a href="${escapeHtml(opts.link.href)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(opts.link.label)}</a></p><p style="font-size:12px;color:#555;word-break:break-all">${escapeHtml(opts.link.href)}</p>` : ''}
${opts.footer ? `<hr style="border:none;border-top:1px solid #ddd"><p style="font-size:12px;color:#666">${escapeHtml(opts.footer)}</p>` : ''}
</body></html>`;
  return { text, html };
}
