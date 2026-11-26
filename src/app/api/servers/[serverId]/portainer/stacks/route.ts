import { NextRequest, NextResponse } from 'next/server';
import { requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { ImportError, listCandidates } from '@/lib/portainer/import';

export const dynamic = 'force-dynamic';

/** Stacks on this server that Bosun does not manage yet, with what each can be imported from. Signed-in Full access only. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    return ok(await listCandidates(serverId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ImportError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
