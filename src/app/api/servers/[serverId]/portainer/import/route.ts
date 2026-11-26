import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { PortainerError } from '@/lib/portainer/client';
import { ImportError, startImport } from '@/lib/portainer/import';

export const dynamic = 'force-dynamic';

/**
 * Import one stack: POST { name, from: 'portainer' | 'containers', detach: boolean }. Answers 202 with the deployment's job;
 * detaching from Portainer follows in the background and the outcome appears in the bell. Signed-in Full access only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  let body: { name?: unknown; from?: unknown; detach?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (typeof body.name !== 'string' || !body.name) return fail('name is required');
  if (body.from !== 'portainer' && body.from !== 'containers') return fail('from must be "portainer" or "containers"');
  try {
    return ok(await startImport(auth, serverId, body.name, body.from, body.detach === true, clientIp(request) ?? undefined), { status: 202 });
  } catch (error) {
    if (error instanceof ImportError || error instanceof PortainerError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
