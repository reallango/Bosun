import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, failFrom } from '@/lib/api/response';
import { accessView } from '@/lib/access/view';

export const dynamic = 'force-dynamic';

/**
 * What the caller (an API key or a signed-in user) may do, what it could ask for, and how: GET /api/access.
 * Meant for agents: read this, then POST /api/access-requests for anything missing. Every 403 also names the
 * permission (and the stack/container) that was missing.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok(await accessView(auth), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
