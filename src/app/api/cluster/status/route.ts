import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { getClusterSummary } from '@/lib/cluster/status';
import { ok, failFrom } from '@/lib/api/response';

/** Cluster health as seen from this node (leader, quorum, nodes, poller). */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok(await getClusterSummary());
  } catch (error) {
    return failFrom(error);
  }
}
