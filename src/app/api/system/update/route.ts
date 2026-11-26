import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { checkForUpdate, setUpdateConfig, startRollout, updateStatus, UpdateError } from '@/lib/update/rollout';

export const dynamic = 'force-dynamic';

/** Self-update (Settings → Updates). Signed-in Full access only. GET: versions, latest image, plan, problems, current update. */
export async function GET(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    return ok(await updateStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}

/** Settings: { image?, channel?, web_port? }. */
export async function PUT(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  let body: { image?: unknown; channel?: unknown; web_port?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    return ok({ config: await setUpdateConfig({
      ...(typeof body.image === 'string' ? { image: body.image.trim() } : {}),
      ...(typeof body.channel === 'string' ? { channel: body.channel.trim() } : {}),
      ...(body.web_port !== undefined ? { webPort: Number(body.web_port) } : {}),
    }) });
  } catch (error) {
    if (error instanceof UpdateError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}

/** { action: 'check' } looks for a newer image now; { action: 'start', confirm: true } starts the rolling update. */
export async function POST(request: NextRequest) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  let body: { action?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    if (body.action === 'check') return ok({ latest: await checkForUpdate() });
    if (body.action === 'start') {
      if (body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
      return ok({ rollout: await startRollout(auth, clientIp(request) ?? undefined) }, { status: 202 });
    }
    return fail('action must be "check" or "start"');
  } catch (error) {
    if (error instanceof UpdateError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
