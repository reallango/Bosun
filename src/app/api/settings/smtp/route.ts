/**
 * Outgoing email (SMTP) settings. Admin only.
 *
 * GET  -> { enabled, host, port, security, user, has_password, from, app_url }
 * PUT  <- any of { enabled, host, port, security, user, password, clear_password, from, app_url }
 *         `password` (non-empty) replaces the stored one; `clear_password: true` removes it.
 * The password is stored encrypted (smtp.password_enc) and never returned.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { setConfig } from '@/lib/db/migrations';
import { encrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { readSmtpValues } from '@/lib/mail';
import { isValidFrom } from '@/lib/collect/recipients';

const SECURITY = ['none', 'starttls', 'tls'];

async function snapshot() {
  const v = await readSmtpValues();
  return {
    enabled: v['smtp.enabled'] === 'true',
    host: v['smtp.host'] || '',
    port: Number(v['smtp.port']) || 587,
    security: SECURITY.includes(String(v['smtp.security'])) ? String(v['smtp.security']) : 'starttls',
    user: v['smtp.user'] || '',
    has_password: !!v['smtp.password_enc'],
    from: v['smtp.from'] || '',
    app_url: v['app.url'] || '',
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  try {
    return ok(await snapshot());
  } catch (error) {
    return failFrom(error);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  try {
    const b = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return fail('Expected a JSON body', 400, 'INVALID_BODY');
    const current = await snapshot();
    const updates: [string, string][] = [];
    const changed: string[] = [];

    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    if (b.host !== undefined) {
      const host = str(b.host);
      if (host && !/^[A-Za-z0-9.\-:[\]]{1,253}$/.test(host)) return fail('Invalid SMTP host');
      updates.push(['smtp.host', host]);
      current.host = host;
    }
    if (b.port !== undefined) {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('Port must be 1-65535');
      updates.push(['smtp.port', String(port)]);
    }
    if (b.security !== undefined) {
      if (!SECURITY.includes(String(b.security))) return fail('Security must be none, starttls or tls');
      updates.push(['smtp.security', String(b.security)]);
    }
    if (b.user !== undefined) {
      const user = str(b.user);
      if (user.length > 254 || /[\r\n]/.test(user)) return fail('Invalid SMTP user');
      updates.push(['smtp.user', user]);
    }
    if (b.from !== undefined) {
      const from = str(b.from);
      if (from && !isValidFrom(from)) return fail('Sender must be an address or "Name <address>"');
      updates.push(['smtp.from', from]);
      current.from = from;
    }
    if (b.app_url !== undefined) {
      const url = str(b.app_url).replace(/\/+$/, '');
      if (url) {
        let parsed: URL | null = null;
        try { parsed = new URL(url); } catch { parsed = null; }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) return fail('Public URL must start with http:// or https://');
      }
      updates.push(['app.url', url]);
    }
    if (b.clear_password === true) {
      updates.push(['smtp.password_enc', '']);
      changed.push('password cleared');
    } else if (typeof b.password === 'string' && b.password !== '') {
      if (b.password.length > 1024) return fail('Password too long');
      updates.push(['smtp.password_enc', encrypt(b.password, getMasterKey())]);
      changed.push('password set');
    }
    if (b.enabled !== undefined) {
      const enabled = b.enabled === true || b.enabled === 'true';
      if (enabled && (!current.host || !current.from)) return fail('Host and sender address are required to enable email');
      updates.push(['smtp.enabled', enabled ? 'true' : 'false']);
    }

    for (const [k, v] of updates) await setConfig(k, v);
    changed.push(...updates.filter(([k]) => k !== 'smtp.password_enc').map(([k, v]) => `${k}=${v}`));
    await logAudit({ userId: auth.userId, action: 'config.update', category: 'config', status: 'success', details: `SMTP settings: ${changed.join(', ')}`.slice(0, 1000) });
    return ok(await snapshot());
  } catch (error) {
    return failFrom(error);
  }
}
