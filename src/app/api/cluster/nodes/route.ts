import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, failFrom } from '@/lib/api/response';

/** Cluster members with real reachability (rqlite /nodes), in the shape the cluster page uses. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const nodes = await rqlite.getNodes();
    return ok(nodes.map(n => ({
      id: n.id,
      address: n.api_addr || n.addr,
      raft_address: n.addr,
      voter: n.voter,
      is_leader: n.leader,
      reachable: n.reachable,
      error: n.error ?? null,
    })));
  } catch (error) {
    return failFrom(error);
  }
}
