import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { ok, fail, failFrom } from '@/lib/api/response';

/** Containers as last collected by the poller (no SSH). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    const r = await rqlite.query("SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = 'docker'", [serverId]);
    if (!r.values?.length) return fail('No container data collected yet', 404);
    const docker = JSON.parse(String(r.values[0][0]));
    return ok({ ...docker, collectedAt: new Date(Number(r.values[0][1])).toISOString() });
  } catch (error) {
    return failFrom(error);
  }
}
