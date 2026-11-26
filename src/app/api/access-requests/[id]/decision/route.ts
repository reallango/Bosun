import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserSession } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { decideRequest, RequestError } from '@/lib/access/requests';

export const dynamic = 'force-dynamic';

/**
 * Approve or deny a request: POST { decision: 'approve' | 'deny', note? }. Signed-in people only (API keys never
 * decide); the rules are in lib/access/requests.ts. Approving a one-time action runs it now, as the requester.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUserSession(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  let body: { decision?: unknown; note?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.decision !== 'approve' && body.decision !== 'deny') return fail('decision must be "approve" or "deny"');
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) return fail('note must be text of up to 500 characters');
  try {
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    return ok({ request: await decideRequest(auth, id, body.decision, note, clientIp(request) ?? undefined) });
  } catch (error) {
    if (error instanceof RequestError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
