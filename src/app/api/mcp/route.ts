import { NextRequest, NextResponse } from 'next/server';
import { handleMcpRequest, wantsMcpStream } from '@/lib/mcp/http';
import { mcpInfo, requestOrigin } from '@/lib/mcp/info';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * MCP (Streamable HTTP, stateless): POST JSON-RPC messages here. GET without MCP headers describes the endpoint for
 * humans; GET with MCP headers answers 405 because this deployment uses JSON responses rather than server-sent events.
 */
export async function GET(request: NextRequest) {
  if (wantsMcpStream(request)) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This endpoint returns JSON responses. POST JSON-RPC messages to /api/mcp.' } },
      { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(mcpInfo(requestOrigin(request)), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  return handleMcpRequest(request);
}

export async function DELETE() {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless.' } },
    { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' } },
  );
}
