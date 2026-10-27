import { describe, it, expect } from 'vitest';
import { quorumSize, clusterState } from './status';
import { isNoLeaderResponse } from '@/lib/db/rqlite-client';

describe('cluster quorum', () => {
  it('needs a strict majority of voters', () => {
    expect([1, 2, 3, 4, 5].map(quorumSize)).toEqual([1, 2, 2, 3, 3]);
  });
  it('classifies cluster state', () => {
    expect(clusterState(3, 3, true)).toBe('ok');
    expect(clusterState(3, 2, true)).toBe('reduced');
    expect(clusterState(3, 1, false)).toBe('no_quorum');
    expect(clusterState(1, 1, true)).toBe('single');
  });
});

describe('isNoLeaderResponse', () => {
  it('recognises rqlite no-leader answers', () => {
    expect(isNoLeaderResponse(503, '')).toBe(true);
    expect(isNoLeaderResponse(500, 'leader not found')).toBe(true);
    expect(isNoLeaderResponse(200, 'not leader')).toBe(true);
    expect(isNoLeaderResponse(200, 'no such table: x')).toBe(false);
  });
});
