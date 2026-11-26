import { describe, it, expect, vi } from 'vitest';

const rows = [
  { id: 'n1', kind: 'alert', severity: 'info', title: 'shared', message: '', link: null, is_read: 0, server_id: null, audience: null, data: null, created_at: '2026-11-26' },
  { id: 'n2', kind: 'access_decision', severity: 'success', title: 'for u1', message: '', link: null, is_read: 0, server_id: null, audience: null, data: JSON.stringify({ recipientUserId: 'u1' }), created_at: '2026-11-26' },
  { id: 'n3', kind: 'access_decision', severity: 'success', title: 'for u2', message: '', link: null, is_read: 0, server_id: null, audience: null, data: JSON.stringify({ recipientUserId: 'u2' }), created_at: '2026-11-26' },
];
const inserted: unknown[][] = [];

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { rows: unknown[] }) => r.rows,
  rqlite: {
    query: async () => ({ rows }),
    execute: async (_sql: string, params: unknown[]) => { inserted.push(params); return { rows_affected: 1 }; },
  },
}));
vi.mock('@/lib/permissions/effective', () => ({ serverVisible: async () => true }));

describe('personal notifications', () => {
  it('are shown only to their recipient; shared ones to everyone', async () => {
    const { listForViewer } = await import('./store');
    const ids = async (userId: string, role = 'admin') => (await listForViewer({ userId, username: 'x', role } as never)).map(n => n.id);
    expect(await ids('u1')).toEqual(['n1', 'n2']);
    expect(await ids('u2', 'viewer')).toEqual(['n1', 'n3']);
    expect(await ids('u3')).toEqual(['n1']);
  });

  it('store the recipient with the notification\'s data', async () => {
    const { notify, recipientOf } = await import('./store');
    await notify({ kind: 'access_decision', severity: 'success', title: 't', message: 'm', recipientUserId: 'u9', data: { requestId: 'r1' } });
    const data = inserted.at(-1)![9] as string;
    expect(JSON.parse(data)).toEqual({ requestId: 'r1', recipientUserId: 'u9' });
    expect(recipientOf(data)).toBe('u9');
    expect(recipientOf(null)).toBeNull();
    expect(recipientOf('{not json')).toBeNull();
  });
});
