import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/rqlite-client', () => ({ rqlite: {}, rowsToObjects: () => [] }));
vi.mock('@/lib/permissions/authorize', () => ({ hasPermission: async () => true }));
vi.mock('@/lib/permissions/effective', () => ({ serverVisible: async () => true }));
vi.mock('@/lib/widgets/runtime/execute', () => ({ loadWidgetSpec: async () => null }));

import { starterName } from './tasks';

describe('who started a task', () => {
  const names = {
    users: new Map([['u1', 'Sean'], ['u2', 'ops-bot']]),
    apiKeys: new Map([['k1', 'AI-Audiobook']]),
  };

  it('names people and API keys, and says when the account is gone', () => {
    expect(starterName('u1', names)).toBe('Sean');
    expect(starterName('apikey:k1', names)).toBe('AI-Audiobook (API key)');
    expect(starterName('apikey:gone', names)).toBe('a deleted API key');
    expect(starterName('u9', names)).toBe('a deleted user');
    expect(starterName(null, names)).toBeNull();
  });
});
