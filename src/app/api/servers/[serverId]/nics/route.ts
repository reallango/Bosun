import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, failFrom } from '@/lib/api/response';

/**
 * Network interfaces the poller last saw on a server, with its suggested
 * Wake-on-LAN MACs: { primary, alt, serverIp, candidates[], collectedAt }.
 * `null` until the first poll has collected interfaces.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    const r = await rqlite.query("SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = 'nics'", [serverId]);
    if (!r.values?.length) return ok(null);
    return ok({ ...JSON.parse(String(r.values[0][0])), collectedAt: new Date(Number(r.values[0][1])).toISOString() });
  } catch (error) {
    return failFrom(error);
  }
}
