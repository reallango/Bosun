import { NextRequest } from 'next/server';
import { redeemJoinToken } from '@/lib/cluster/control';
import { checkLoginRateLimit, recordLoginAttempt } from '@/lib/utils/rate-limiter';
import { clientIp } from '@/lib/auth/session';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

/**
 * Redeem a one-time join code (version 2): POST { id, proof } -> { iv, tag, ct }, the cluster secrets sealed for the
 * holder of the code. Called by a node that is joining, which has no account here, so it is public but rate limited
 * like a login; the proof shows the caller holds the code's secret without sending it. See lib/cluster/join-token.ts.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = checkLoginRateLimit(ip);
  if (!limit.allowed) return fail('Too many attempts', 429, 'RATE_LIMITED');
  let body: { id?: unknown; proof?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    const sealed = await redeemJoinToken(body.id, body.proof);
    await logAudit({ action: 'cluster.join_code_redeemed', category: 'cluster', status: 'success', ipAddress: ip, details: 'A node redeemed a join code' }).catch(() => undefined);
    return ok(sealed, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    recordLoginAttempt(ip);
    await logAudit({ action: 'cluster.join_code_redeemed', category: 'cluster', status: 'failure', ipAddress: ip, details: error instanceof Error ? error.message.slice(0, 200) : 'failed' }).catch(() => undefined);
    return failFrom(error);
  }
}
