import { describe, it, expect } from 'vitest';
import * as mailer from './mailer';
import { parseRecipients, isValidEmail, isValidFrom } from './recipients';

const cfg = { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'u', password: 'p', from: 'Bosun <bosun@example.com>' };

describe('recipients', () => {
  it('parses comma/semicolon/space separated lists and drops duplicates', () => {
    expect(parseRecipients('a@x.io, b@y.org;c@z.net  A@x.io')).toEqual({ emails: ['a@x.io', 'b@y.org', 'c@z.net'], invalid: [] });
    expect(parseRecipients(['a@x.io', 'nope'])).toEqual({ emails: ['a@x.io'], invalid: ['nope'] });
    expect(parseRecipients('')).toEqual({ emails: [], invalid: [] });
    expect(parseRecipients(undefined)).toEqual({ emails: [], invalid: [] });
  });

  it('rejects malformed and header-injecting addresses', () => {
    expect(isValidEmail('ops@example.com')).toBe(true);
    expect(isValidEmail('ops@localhost')).toBe(false);
    expect(isValidEmail('a@b.c\r\nBcc: x@y.z')).toBe(false);
    expect(isValidEmail('<a@b.co>')).toBe(false);
    expect(isValidFrom('Bosun <bosun@example.com>')).toBe(true);
    expect(isValidFrom('bosun@example.com')).toBe(true);
    expect(isValidFrom('Bosun <bosun@example.com>\nBcc: x@y.z')).toBe(false);
    expect(isValidFrom('Bosun')).toBe(false);
  });

  it('caps the number of recipients', () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@x.io`).join(',');
    expect(parseRecipients(many).invalid).toHaveLength(1);
  });
});

describe('mailer', () => {
  it('maps security modes to nodemailer options', () => {
    expect(mailer.transportOptions({ ...cfg, security: 'tls', port: 465 })).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false, port: 465 });
    expect(mailer.transportOptions(cfg)).toMatchObject({ secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' } });
    expect(mailer.transportOptions({ ...cfg, security: 'none', user: '' })).toMatchObject({ ignoreTLS: true });
    expect(mailer.transportOptions({ ...cfg, user: '' }).auth).toBeUndefined();
  });

  it('validates the config', () => {
    expect(mailer.configError(cfg)).toBeNull();
    expect(mailer.configError({ ...cfg, host: '' })).toMatch(/host/);
    expect(mailer.configError({ ...cfg, port: 0 })).toMatch(/port/);
    expect(mailer.configError({ ...cfg, from: 'x' })).toMatch(/sender/);
    expect(() => mailer.createMailer({ ...cfg, host: '' })).toThrow(/host/);
  });

  it('sends through a JSON transport', async () => {
    const m = mailer.createMailer(cfg, { transport: { jsonTransport: true } });
    const info = await m.send({ to: ['a@x.io'], subject: 'Hello', text: 'Body', html: '<p>Body</p>' });
    const msg = JSON.parse(info.message);
    expect(msg.subject).toBe('Hello');
    expect(msg.to).toEqual([{ address: 'a@x.io', name: '' }]);
    expect(msg.from).toEqual({ address: 'bosun@example.com', name: 'Bosun' });
    expect(msg.text).toBe('Body');
    await expect(m.send({ to: [], subject: 'x', text: 'y' })).rejects.toThrow(/recipients/);
    await expect(m.send({ to: 'a@x.io', subject: 'x\r\nBcc: e@v.il', text: 'y' })).rejects.toThrow(/subject/);
  });

  it('builds the config from app_config values and decrypts the password', () => {
    const values = { 'smtp.enabled': 'true', 'smtp.host': 'h.example', 'smtp.port': '2525', 'smtp.security': 'none', 'smtp.user': 'me', 'smtp.password_enc': 'ENC', 'smtp.from': 'a@b.co' };
    expect(mailer.configFromValues(values, (e: string) => `dec(${e})`)).toEqual({ host: 'h.example', port: 2525, security: 'none', user: 'me', password: 'dec(ENC)', from: 'a@b.co' });
    expect(mailer.configFromValues({ ...values, 'smtp.enabled': 'false' }, () => '')).toBeNull();
    expect(mailer.configFromValues({ ...values, 'smtp.enabled': 'false' }, () => '', { ignoreEnabled: true })).not.toBeNull();
    expect(mailer.configFromValues({ ...values, 'smtp.password_enc': 'bad' }, () => { throw new Error('x'); })?.password).toBe('');
  });

  it('caches the mailer and rebuilds only when the config changes', async () => {
    let t = 0;
    let current: typeof cfg | null = cfg;
    let loads = 0;
    const get = mailer.mailerCache(async () => { loads++; return current; }, { ttlMs: 60_000, now: () => t, transport: { jsonTransport: true } });
    const a = await get();
    expect(a).not.toBeNull();
    t = 30_000;
    expect(await get()).toBe(a);
    expect(loads).toBe(1);
    t = 61_000;
    expect(await get()).toBe(a); // reloaded, unchanged
    expect(loads).toBe(2);
    current = { ...cfg, host: 'other.example.com' };
    t = 122_000;
    const b = await get();
    expect(b).not.toBe(a);
    current = null;
    t = 183_000;
    expect(await get()).toBeNull();
  });

  it('escapes HTML', () => {
    expect(mailer.escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
