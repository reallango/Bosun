import { NextRequest, NextResponse } from 'next/server';
import { mcpInfo, requestOrigin } from '@/lib/mcp/info';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Short discovery document for humans and clients that do not speak MCP yet. */
export async function GET(request: NextRequest) {
  return NextResponse.json(mcpInfo(requestOrigin(request)), { headers: { 'Cache-Control': 'no-store' } });
}
