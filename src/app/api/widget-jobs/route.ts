import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, failFrom } from '@/lib/api/response';
import { recentJobs } from '@/lib/widgets/jobs/store';
import { dismissedJobIds } from '@/lib/widgets/jobs/task-state';
import { mayUse, nameMaps, toTask } from '@/lib/widgets/jobs/tasks';

/** The newest jobs (tasks) of package widgets that the caller started or may run, for the notification area: GET /api/widget-jobs. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const names = await nameMaps();
    const dismissed = await dismissedJobIds(auth.userId);
    const tasks = [];
    for (const j of await recentJobs(30)) {
      if (!(await mayUse(auth, j))) continue;
      tasks.push(await toTask(j, auth, names, dismissed.has(j.id)));
      if (tasks.length >= 15) break;
    }
    return ok({ tasks }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
