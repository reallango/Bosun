import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { deleteSchedule, getSchedule, ScheduleError, updateSchedule } from '@/lib/schedules/service';

export const dynamic = 'force-dynamic';

/** GET one schedule, PATCH it (including pause/resume), DELETE it. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    return ok({ schedule: await getSchedule(auth, id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid JSON body');
  try {
    return ok({ schedule: await updateSchedule(auth, id, body, clientIp(request) ?? undefined) });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    await deleteSchedule(auth, id, clientIp(request) ?? undefined);
    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof ScheduleError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
