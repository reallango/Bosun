import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { cancelRequest, getRequest } from '@/lib/access/requests';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** One request: its status and, once decided, the decision and (one-time actions) the action's answer. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const r = await getRequest(auth, id);
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
