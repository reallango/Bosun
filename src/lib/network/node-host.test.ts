import { describe, it, expect } from 'vitest';

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
