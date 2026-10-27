/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), with node:crypto only.
 * Defaults match authenticator apps: SHA-1, 6 digits, 30-second steps.
 */
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = ((value << 8) | buf[i]) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** HOTP value for `counter` (RFC 4226 section 5.3, dynamic truncation). */
export function hotp(key: Buffer, counter: number | bigint, digits = 6, algorithm: HashAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  step?: number;
  digits?: number;
  algorithm?: HashAlgorithm;
}

export function totpCounter(timeMs: number, step = 30): number {
  return Math.floor(timeMs / 1000 / step);
}

export function totp(key: Buffer, timeMs: number, opts: TotpOptions = {}): string {
  return hotp(key, totpCounter(timeMs, opts.step ?? 30), opts.digits ?? 6, opts.algorithm ?? 'sha1');
}

/**
 * Check a code against the base32 secret, accepting `window` steps of clock
 * drift either side. Returns the matching time-step counter (so callers can
 * refuse a replayed code) or null. Compares in constant time.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secretBase32);
  const counter = totpCounter(nowMs);
  let match: number | null = null;
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(hotp(key, counter + i));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean)) && match === null) match = counter + i;
  }
  return match;
}

/** New random seed: 20 bytes (160 bits, RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'Bosun'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
