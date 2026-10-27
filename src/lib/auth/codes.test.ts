import { describe, it, expect } from 'vitest';
import {
  sha256Hex, safeEqualHex, numericCode, randomToken, generateBackupCodes, matchBackupCode, parseBackupHashes,
  normalizeBackupCode, isNumericCode,
} from './codes';

describe('one-time codes', () => {
  it('generates 6-digit numeric codes and base64url tokens', () => {
    for (let i = 0; i < 50; i++) expect(numericCode()).toMatch(/^\d{6}$/);
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
  });

  it('compares hashes in constant time and handles length mismatch', () => {
    const h = sha256Hex('abc');
    expect(safeEqualHex(h, sha256Hex('abc'))).toBe(true);
    expect(safeEqualHex(h, sha256Hex('abd'))).toBe(false);
    expect(safeEqualHex(h, h.slice(1))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });

  it('tells numeric codes from backup codes', () => {
    expect(isNumericCode('123456')).toBe(true);
    expect(isNumericCode('123 456')).toBe(true);
    expect(isNumericCode('12345')).toBe(false);
    expect(isNumericCode('k7m2p-x9qrt')).toBe(false);
  });
});

describe('backup codes', () => {
  it('generates 10 distinct codes stored only as hashes', () => {
    const { codes, hashes } = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(hashes.every(h => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(hashes).not.toContain(codes[0]);
  });

  it('consumes a matching code once, tolerating case, spaces and dashes', () => {
    const { codes, hashes } = generateBackupCodes(3);
    const stored = parseBackupHashes(JSON.stringify(hashes));
    const typed = ` ${codes[1].toUpperCase().replace('-', ' ')} `;
    expect(normalizeBackupCode(typed)).toBe(codes[1].replace('-', ''));
    const remaining = matchBackupCode(stored, typed);
    expect(remaining).toHaveLength(2);
    expect(matchBackupCode(remaining!, codes[1])).toBeNull();
    expect(matchBackupCode(remaining!, codes[0])).toHaveLength(1);
    expect(matchBackupCode(stored, 'short')).toBeNull();
  });

  it('parses stored JSON defensively', () => {
    expect(parseBackupHashes(null)).toEqual([]);
    expect(parseBackupHashes('not json')).toEqual([]);
    expect(parseBackupHashes('{"a":1}')).toEqual([]);
    expect(parseBackupHashes('["x", 1]')).toEqual(['x']);
  });
});
