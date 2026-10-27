import { NextResponse } from 'next/server';
import { ensureDatabase } from '@/lib/db/initialize';

/** Liveness/readiness probe used by the container healthcheck. */
export async function GET() {
  try {
    await ensureDatabase();
    return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ status: 'error', error: (error as Error).message }, { status: 503 });
  }
}
