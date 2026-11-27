/**
 * Per-person task state for the bell. A finished task can be dismissed from one person's bell without
 * affecting anyone else's; the Activity page still lists it and can restore it.
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';

/** The jobs this person has dismissed from their bell. */
export async function dismissedJobIds(userId: string | null | undefined): Promise<Set<string>> {
  if (!userId) return new Set();
  try {
    const rows = rowsToObjects(await rqlite.query('SELECT job_id FROM task_dismissals WHERE user_id = ?', [userId]));
    return new Set(rows.map(r => String(r.job_id)));
  } catch (err) {
    // A missing state table must not break the bell.
    console.warn(`[tasks] could not read dismissals: ${err instanceof Error ? err.message : err}`);
    return new Set();
  }
}

/** Dismiss or restore one job for one person. */
export async function setJobDismissed(userId: string, jobId: string, dismissed: boolean): Promise<void> {
  if (dismissed) {
    await rqlite.execute(
      'INSERT OR REPLACE INTO task_dismissals (job_id, user_id, dismissed_at) VALUES (?, ?, ?)',
      [jobId, userId, Date.now()],
    );
    return;
  }
  await rqlite.execute('DELETE FROM task_dismissals WHERE job_id = ? AND user_id = ?', [jobId, userId]);
}
