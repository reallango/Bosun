import { NextRequest, NextResponse } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { initializeDatabase } from '@/lib/db/initialize';


let initPromise: Promise<void> | null = null;


export async function GET(request: NextRequest) {
    try {
        // Initialize database once (singleton promise)
        if (!initPromise) {
            initPromise = initializeDatabase().catch((err) => {
                console.error('Database init failed:', err);
                initPromise = null; // Allow retry on next request
                throw err;
            });
        }
        await initPromise;


        return NextResponse.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        return NextResponse.json(
            { status: 'error', error: (error as Error).message },
            { status: 500 }
        );
    }
}