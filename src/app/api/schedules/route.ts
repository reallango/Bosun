import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { createSchedule, listSchedules, ScheduleError } from '@/lib/schedules/service';

export const dynamic = 'force-dynamic';

/** GET: the schedules the caller may manage. POST: create one. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok({ schedules: await listSchedules(auth) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid JSON body');
  try {
    return ok({ schedule: await createSchedule(auth, body, clientIp(request) ?? undefined) }, { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
