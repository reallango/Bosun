import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { cancelRequest, getRequest, MAX_WAIT_SECONDS, waitForDecision } from '@/lib/access/requests';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * One request: its status and, once decided, the decision (who, when, their note) and (one-time actions) the action's
 * answer. `?wait=N` (1–50 seconds) holds the call open until the request is decided or N seconds pass, so a requester
 * can wait without polling; it answers the request either way (still `pending` when time ran out).
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const waitRaw = new URL(request.url).searchParams.get('wait');
  let wait = 0;
  if (waitRaw !== null) {
    wait = Number(waitRaw);
    if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) return fail(`wait must be a whole number of seconds from 0 to ${MAX_WAIT_SECONDS}`, 400, 'VALIDATION');
  }
  try {
    const r = wait > 0 ? await waitForDecision(auth, id, wait) : await getRequest(auth, id);
    return r ? ok({ request: r }, { headers: { 'Cache-Control': 'no-store' } }) : fail('Request not found', 404, 'NOT_FOUND');
  } catch (error) {
    return failFrom(error);
  }
}

/** Withdraw your own pending request. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    return (await cancelRequest(auth, id)) ? ok({ cancelled: true }) : fail('No pending request of yours with that id', 404, 'NOT_FOUND');
  } catch (error) {
    return failFrom(error);
  }
}
