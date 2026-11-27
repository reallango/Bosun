import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { registeredPermissionDefs } from '@/lib/permissions/store';
import { createRequest, listRequests, RequestError } from '@/lib/access/requests';
import { validateRequestInput } from '@/lib/access/validate';
import { accessRequestLimiter } from '@/lib/access/limiter';

export const dynamic = 'force-dynamic';

/**
 * GET: the caller's requests (`?mine=1`, or for people who can decide, everyone's; `?status=pending`).
 * POST: ask for access. See GET /api/access for the shape and examples.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const q = new URL(request.url).searchParams;
    const status = q.get('status');
    if (status && !['pending', 'approved', 'denied', 'expired', 'cancelled', 'failed'].includes(status)) return fail('Unknown status');
    return ok({ requests: await listRequests(auth, { mine: q.get('mine') === '1', status: status ?? undefined, limit: Number(q.get('limit')) || 100 }) },
      { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (!accessRequestLimiter.consume(String(auth.userId)).allowed) return fail('Too many requests; try again later', 429, 'RATE_LIMITED');
  let body: unknown;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  const input = validateRequestInput(body, await registeredPermissionDefs());
  if (!input.ok) return fail(input.error, 400, 'VALIDATION');
  try {
    return ok({ request: await createRequest(auth, input.value) }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
