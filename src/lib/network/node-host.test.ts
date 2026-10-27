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
