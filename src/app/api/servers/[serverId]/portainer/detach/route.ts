import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { PortainerError } from '@/lib/portainer/client';
import { ImportError, startDetach } from '@/lib/portainer/import';

export const dynamic = 'force-dynamic';

/**
 * Detach a stack Bosun already manages from Portainer: POST { name }. Answers 202; Portainer stops the stack while deleting
 * it, Bosun's waiter starts it again, and the outcome appears in the bell. Signed-in Full access only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  let body: { name?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (typeof body.name !== 'string' || !body.name) return fail('name is required');
  try {
    return ok(await startDetach(auth, serverId, body.name, clientIp(request) ?? undefined), { status: 202 });
  } catch (error) {
    if (error instanceof ImportError || error instanceof PortainerError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
