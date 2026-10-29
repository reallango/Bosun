import { describe, it, expect } from 'vitest';
import { matchContainerHost } from './node-host';

describe('matchContainerHost', () => {
  const snaps = [
    { serverId: 'pc', containers: [{ id: 'aaaaaaaaaaaa' }] },
    { serverId: 'nuc', containers: [{ id: '0123456789ab' }, { id: 'ffffffffffff' }] },
  ];
  it('finds the server whose docker list contains this container (full or short id)', () => {
    expect(matchContainerHost(['0123456789ab' + 'c'.repeat(52)], snaps)).toBe('nuc');
    expect(matchContainerHost(['0123456789ab'], snaps)).toBe('nuc');
  });
  it('returns null when no host runs this container', () => {
    expect(matchContainerHost(['999999999999'], snaps)).toBeNull();
    expect(matchContainerHost([], snaps)).toBeNull();
  });
});

describe('matchInspectOutput', () => {
  const full = 'a'.repeat(12) + 'b'.repeat(52);
  it('accepts the full id of one of our containers and nothing else', async () => {
    const { matchInspectOutput } = await import('./node-host');
    expect(matchInspectOutput(['a'.repeat(12)], full + '\n')).toBe(true);
    expect(matchInspectOutput(['a'.repeat(64)], full)).toBe(true);
    expect(matchInspectOutput(['c'.repeat(12)], full)).toBe(false);
    expect(matchInspectOutput(['a'.repeat(12)], '')).toBe(false);
    expect(matchInspectOutput(['a'.repeat(12)], 'Error: No such object')).toBe(false);
    expect(matchInspectOutput(['a'.repeat(12)], 'a'.repeat(12))).toBe(false);   // a short id is not proof
    expect(matchInspectOutput([], full)).toBe(false);
  });
});
