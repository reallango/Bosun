import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { listPullJobs } from '@/lib/ollama/actions';
import { ok, failFrom } from '@/lib/api/response';

/** Ollama status/models as last collected by the poller, plus active pulls. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    const r = await rqlite.query("SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = 'ollama'", [serverId]);
    const ollama = r.values?.length ? JSON.parse(String(r.values[0][0])) : null;
    const collectedAt = r.values?.length ? new Date(Number(r.values[0][1])).toISOString() : null;
    return ok({ ollama, collectedAt, pulls: listPullJobs(serverId) });
  } catch (error) {
    return failFrom(error);
  }
}
