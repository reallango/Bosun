import { describe, it, expect, vi } from 'vitest';

const rows = [
  { id: 'a1', kind: 'alert', severity: 'info', title: 'Disk warning', message: 'disk nearly full', link: null, is_read: 0, is_dismissed: 0, server_id: null, audience: null, data: null, created_at: '2026-11-26T10:00:00.000Z' },
  { id: 'a2', kind: 'alert', severity: 'warning', title: 'Old alert', message: 'dismissed but kept', link: null, is_read: 1, is_dismissed: 1, server_id: null, audience: null, data: null, created_at: '2026-11-26T09:00:00.000Z' },
  { id: 'a3', kind: 'widget_update', severity: 'info', title: 'Update ready', message: 'new package version', link: '/settings/widgets', is_read: 0, is_dismissed: 0, server_id: 's1', audience: 'operator', data: null, created_at: '2026-11-26T08:00:00.000Z' },
  { id: 'a4', kind: 'access_request', severity: 'critical', title: 'Access asked', message: 'please approve', link: '/settings/access-requests', is_read: 0, is_dismissed: 0, server_id: 's2', audience: null, data: JSON.stringify({ requestId: 'r1' }), created_at: '2026-11-26T07:00:00.000Z' },
  { id: 'a5', kind: 'access_decision', severity: 'success', title: 'Your request', message: 'was approved', link: null, is_read: 0, is_dismissed: 0, server_id: null, audience: null, data: JSON.stringify({ recipientUserId: 'u2' }), created_at: '2026-11-26T06:00:00.000Z' },
  { id: 'a6', kind: 'alert', severity: 'warning', title: 'Hidden server', message: 'secret', link: null, is_read: 0, is_dismissed: 0, server_id: 's3', audience: null, data: null, created_at: '2026-11-26T05:00:00.000Z' },
  { id: 'a7', kind: 'alert', severity: 'info', title: 'Needle', message: 'found in the haystack', link: null, is_read: 1, is_dismissed: 0, server_id: 's1', audience: null, data: null, created_at: '2026-11-26T04:00:00.000Z' },
];

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { rows: unknown[] }) => r.rows,
  rqlite: {
    query: async () => ({ rows }),
    execute: async () => ({ rows_affected: 1 }),
  },
}));
vi.mock('@/lib/permissions/effective', () => ({
  serverVisible: async (_viewer: unknown, serverId: string) => serverId !== 's3',
}));

const viewer = (userId = 'u1', role = 'admin') => ({ userId, username: 'u1', role } as never);
const ids = (page: { notifications: { id: string }[] } | { id: string }[]) =>
  (Array.isArray(page) ? page : page.notifications).map(n => n.id);

describe('notification history visibility', () => {
  it('leaves dismissed rows out of the bell but includes them in history', async () => {
    const { listForViewer, listHistory } = await import('./store');
    expect(ids(await listForViewer(viewer()))).not.toContain('a2');
    expect(ids(await listHistory(viewer()))).toContain('a2');
  });

  it('applies the bell rules to history too: audience, personal recipient and hidden servers', async () => {
    const { listHistory } = await import('./store');
    expect(ids(await listHistory(viewer('u1', 'viewer')))).not.toContain('a3'); // operator audience
    expect(ids(await listHistory(viewer('u1')))).not.toContain('a5'); // for u2
    expect(ids(await listHistory(viewer('u2')))).toContain('a5');
    expect(ids(await listHistory(viewer()))).not.toContain('a6'); // hidden server
  });

  it('filters by kind group, server and text, and pages with a cursor', async () => {
    const { listHistory } = await import('./store');
    expect(ids(await listHistory(viewer(), { kind: 'update' }))).toEqual(['a3']);
    expect(ids(await listHistory(viewer(), { serverId: 's1' }))).toEqual(['a3', 'a7']);
    expect(ids(await listHistory(viewer(), { q: 'needle' }))).toEqual(['a7']);
    expect(ids(await listHistory(viewer(), { q: 'haystack' }))).toEqual(['a7']);

    const page = await listHistory(viewer(), { limit: 2 });
    expect(ids(page.notifications)).toEqual(['a1', 'a2']);
    expect(page.nextBefore).toBe('2026-11-26T09:00:00.000Z');
    const next = await listHistory(viewer(), { limit: 2, before: page.nextBefore });
    expect(ids(next.notifications)).toEqual(['a3', 'a4']);
  });

  it('returns no notifications for the tasks-only filter', async () => {
    const { listHistory } = await import('./store');
    expect(await listHistory(viewer(), { kind: 'tasks' })).toEqual({ notifications: [], nextBefore: null });
  });

  it('checks one row by id with the same visibility rules', async () => {
    const { listForViewer } = await import('./store');
    expect(ids(await listForViewer(viewer(), { id: 'a2', includeDismissed: true }))).toEqual(['a2']);
    expect(ids(await listForViewer(viewer(), { id: 'a2' }))).toEqual([]); // dismissed
    expect(ids(await listForViewer(viewer(), { id: 'a6' }))).toEqual([]); // hidden server
    expect(ids(await listForViewer(viewer('u1', 'viewer'), { id: 'a3' }))).toEqual([]); // operator audience
  });
});
