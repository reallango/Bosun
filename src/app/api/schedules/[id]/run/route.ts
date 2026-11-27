import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { runScheduleNow, ScheduleError } from '@/lib/schedules/service';

export const dynamic = 'force-dynamic';

/** Run a schedule now, as the person or API key that created it. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    return ok(await runScheduleNow(auth, id, clientIp(request) ?? undefined));
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
