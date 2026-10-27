import { NextResponse } from 'next/server';
import { ensureDatabase } from '@/lib/db/initialize';
import { rqlite } from '@/lib/db/rqlite-client';

/**
 * Liveness/readiness probe used by the container healthcheck. A node cut off
 * from the cluster majority is still "up" (it serves read-only data), so it
 * answers 200 with status "degraded" rather than failing the healthcheck.
 */
// Never cache: this reports live cluster state.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureDatabase();
    const leader = await rqlite.isReady();
    return NextResponse.json({ status: leader ? 'ok' : 'degraded', leader, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ status: 'error', error: (error as Error).message }, { status: 503 });
  }
}
