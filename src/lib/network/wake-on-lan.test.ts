import { describe, it, expect } from 'vitest';
import { normalizeMac, formatMac, buildMagicPacket, broadcastForIp } from './wake-on-lan';

describe('wake-on-lan', () => {
  it('normalises MAC formats and rejects invalid ones', () => {
    expect(formatMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(formatMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa:bb:cc:dd:ee')).toBeNull();
    expect(formatMac('zz:bb:cc:dd:ee:ff; rm -rf /')).toBeNull();
  });
  it('builds a 102-byte magic packet', () => {
    const p = buildMagicPacket('01:02:03:04:05:06');
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6).every(b => b === 0xff)).toBe(true);
    expect(Array.from(p.subarray(96, 102))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('derives a /24 broadcast for IPv4 only', () => {
    expect(broadcastForIp('192.168.1.171')).toBe('192.168.1.255');
    expect(broadcastForIp('game-bed.lan')).toBeNull();
  });
});
