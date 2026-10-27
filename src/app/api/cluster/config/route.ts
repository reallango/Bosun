import { NextRequest, NextResponse } from 'next/server';
import { requireUserLevel } from '@/lib/auth/middleware';
import { effectiveClusterConfig } from '@/lib/cluster/config';
import { secretSources } from '@/lib/secrets';
import { ok, failFrom } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

/** This node's cluster settings and where each comes from (admin). */
export async function GET(request: NextRequest) {
  // Signed-in admins only: join codes carry the cluster secrets, so API keys are refused.
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  try {
    const host = (request.headers.get('host') || '').split(':')[0];
    return ok({
      ...effectiveClusterConfig(),
      secrets: secretSources(),
      // The address the browser used is usually this machine's LAN address.
      suggested_adv_host: host && host !== 'localhost' && !host.startsWith('127.') ? host : null,
    });
  } catch (error) {
    return failFrom(error);
  }
}
