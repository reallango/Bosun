import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { listScheduleKinds, ScheduleError } from '@/lib/schedules/service';

export const dynamic = 'force-dynamic';

/** The schedule kinds installed widgets declare that the caller may create on this server. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const serverId = new URL(request.url).searchParams.get('server_id');
  if (!serverId) return fail('server_id is required');
  try {
    return ok({ kinds: await listScheduleKinds(auth, serverId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
