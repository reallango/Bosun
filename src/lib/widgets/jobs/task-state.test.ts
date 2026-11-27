import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as { job_id: string; user_id: string; dismissed_at: number }[] }));

vi.mock('@/lib/db/rqlite-client', () => ({
  rowsToObjects: (r: { rows: unknown[] }) => r.rows,
  rqlite: {
    query: async (_sql: string, params: unknown[]) => ({
      rows: db.rows.filter(r => r.user_id === params[0]).map(r => ({ job_id: r.job_id })),
    }),
    execute: async (sql: string, params: unknown[]) => {
      const [jobId, userId, at] = params as [string, string, number];
      db.rows = db.rows.filter(r => !(r.job_id === jobId && r.user_id === userId));
      if (sql.startsWith('INSERT OR REPLACE')) db.rows.push({ job_id: jobId, user_id: userId, dismissed_at: Number(at) });
      return { rows_affected: 1 };
    },
  },
}));

import { dismissedJobIds, setJobDismissed } from './task-state';

beforeEach(() => { db.rows = []; });

describe('per-person task dismissal', () => {
  it('hides a task for the person who dismissed it, not for anyone else', async () => {
    await setJobDismissed('u1', 'job-1', true);
    expect(await dismissedJobIds('u1')).toEqual(new Set(['job-1']));
    expect(await dismissedJobIds('u2')).toEqual(new Set());
    expect(await dismissedJobIds(null)).toEqual(new Set());
  });

  it('puts a task back when restored', async () => {
    await setJobDismissed('u1', 'job-1', true);
    await setJobDismissed('u1', 'job-1', false);
    expect(await dismissedJobIds('u1')).toEqual(new Set());
  });
});
