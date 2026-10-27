import { describe, it, expect } from 'vitest';
import {
  apiKeyState, bearerToken, expiryFromDays, generateApiKey, hashApiKey, parseApiKey, parseDbTime, verifyApiKey,
} from './api-keys';

describe('API key generation', () => {
  it('produces bosun_<8 hex>_<base64url secret>', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^bosun_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`bosun_${prefix}_`)).toBe(true);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is random', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.prefix).not.toBe(b.prefix);
  });
});

describe('API key parsing', () => {
  it('extracts the prefix even when the secret contains underscores', () => {
    const key = 'bosun_0a1b2c3d_' + 'A_b-'.repeat(11);
    expect(parseApiKey(key)).toEqual({ prefix: '0a1b2c3d' });
  });

  it('rejects other strings', () => {
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey(null)).toBeNull();
    expect(parseApiKey('eyJhbGciOi.xx.yy')).toBeNull();
    expect(parseApiKey('bosun_0A1B2C3D_' + 'a'.repeat(43))).toBeNull(); // uppercase prefix
    expect(parseApiKey('bosun_0a1b2c3d_short')).toBeNull();
    expect(parseApiKey('bosun_0a1b2c3d_' + 'a'.repeat(42) + '!')).toBeNull();
  });

  it('reads Bearer headers', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe('API key verification', () => {
  it('accepts the right key and rejects others', () => {
    const { key, hash } = generateApiKey();
    expect(verifyApiKey(key, hash)).toBe(true);
    expect(verifyApiKey(key + 'x', hash)).toBe(false);
    expect(verifyApiKey(generateApiKey().key, hash)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    const { key } = generateApiKey();
    expect(verifyApiKey(key, '')).toBe(false);
    expect(verifyApiKey(key, 'abc')).toBe(false);
  });
});

describe('API key state and expiry', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');

  it('parses SQLite and ISO times', () => {
    expect(parseDbTime('2026-01-10 00:00:00')).toBe(now);
    expect(parseDbTime('2026-01-10T00:00:00.000Z')).toBe(now);
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime('garbage')).toBeNull();
  });

  it('classifies keys', () => {
    expect(apiKeyState({}, now)).toBe('active');
    expect(apiKeyState({ expires_at: '2026-01-11T00:00:00Z' }, now)).toBe('active');
    expect(apiKeyState({ expires_at: '2026-01-09 23:59:59' }, now)).toBe('expired');
    expect(apiKeyState({ revoked_at: '2026-01-01 00:00:00', expires_at: '2026-01-09 00:00:00' }, now)).toBe('revoked');
  });

  it('computes expiry from days', () => {
    expect(expiryFromDays(null, now)).toBeNull();
    expect(expiryFromDays('never', now)).toBeNull();
    expect(expiryFromDays(30, now)).toBe('2026-02-09T00:00:00.000Z');
    expect(expiryFromDays('90', now)).toBe(new Date(now + 90 * 86_400_000).toISOString());
    expect(expiryFromDays(-1, now)).toBeUndefined();
    expect(expiryFromDays(1.5, now)).toBeUndefined();
  });
});
