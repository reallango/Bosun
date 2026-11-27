import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { listRuns, ScheduleError } from '@/lib/schedules/service';

export const dynamic = 'force-dynamic';

/** A page of one schedule's run history, newest first. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const q = new URL(request.url).searchParams;
  try {
    const page = await listRuns(auth, id, { limit: Number(q.get('limit')) || 25, offset: Number(q.get('offset')) || 0 });
    return ok(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
