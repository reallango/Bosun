import { describe, it, expect } from 'vitest';
import { hotp, totp, verifyTotp, base32Encode, base32Decode, generateTotpSecret, otpauthUri } from './totp';

const SHA1_KEY = Buffer.from('12345678901234567890');
const SHA256_KEY = Buffer.from('12345678901234567890123456789012');
const SHA512_KEY = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

describe('HOTP (RFC 4226 appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((v, i) => [i, v]))('counter %i -> %s', (counter, value) => {
    expect(hotp(SHA1_KEY, counter as number)).toBe(value);
  });
});

describe('TOTP (RFC 6238 appendix B, 8 digits)', () => {
  const vectors: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(vectors)('T=%i', (t, sha1, sha256, sha512) => {
    expect(totp(SHA1_KEY, t * 1000, { digits: 8 })).toBe(sha1);
    expect(totp(SHA256_KEY, t * 1000, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
    expect(totp(SHA512_KEY, t * 1000, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
  });
});

describe('verifyTotp', () => {
  const secret = base32Encode(SHA1_KEY);
  const now = 1_111_111_111_000;
  const code = totp(SHA1_KEY, now);

  it('accepts the current code and one step of drift, returning the counter', () => {
    expect(verifyTotp(secret, code, now)).toBe(Math.floor(now / 30000));
    expect(verifyTotp(secret, code, now + 30_000)).toBe(Math.floor(now / 30000));
    expect(verifyTotp(secret, code, now - 30_000)).toBe(Math.floor(now / 30000));
    expect(verifyTotp(secret, code.slice(0, 3) + ' ' + code.slice(3), now)).not.toBeNull();
  });

  it('rejects codes outside the window and malformed input', () => {
    expect(verifyTotp(secret, code, now + 90_000)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(secret, wrong, now, 0)).toBeNull();
  });
});

describe('base32 and secrets', () => {
  it('round-trips and matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    expect(() => base32Decode('M1')).toThrow();
  });

  it('generates 160-bit secrets and otpauth URIs', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    const uri = otpauthUri(s, 'alice');
    expect(uri.startsWith('otpauth://totp/Bosun%3Aalice?')).toBe(true);
    expect(new URL(uri).searchParams.get('secret')).toBe(s);
  });
});
