import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { initializeDatabase } from '@/lib/db/initialize';

let dbInitialized = false;

export async function GET(request: NextRequest) {
  try {
    // Initialize database on first request if not already done
    if (!dbInitialized) {
      await initializeDatabase();
      dbInitialized = true;
    }
    
    const rqliteOk = await rqlite.isReady();
    const status = await rqlite.getStatus();
    const uptime = process.uptime();

    return NextResponse.json({
      status: 'ok',
      node: status.node,
      rqlite: rqliteOk ? 'ok' : 'error',
      uptime: Math.floor(uptime)
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', error: (error as Error).message },
      { status: 500 }
    );
  }
}