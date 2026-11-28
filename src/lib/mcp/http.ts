/** Streamable HTTP transport for /api/mcp, stateless: each request authenticates and gets a fresh transport. */
import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { clientIp, requireAuth } from '@/lib/auth/middleware';
import { createBosunMcpServer } from './runtime';

/** MCP messages are small; tool arguments (a compose file, a settings blob) are the largest part. */
export const MAX_MCP_BODY_BYTES = 1_048_576;

export function wantsMcpStream(request: NextRequest): boolean {
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/event-stream')
    || request.headers.has('mcp-session-id')
    || request.headers.has('mcp-protocol-version')
    || request.headers.has('last-event-id');
}

function jsonRpcError(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32000, message, ...(code ? { data: { code } } : {}) } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function authFailure(response: NextResponse): Promise<NextResponse> {
  let body: { error?: { message?: string; code?: string } } | null = null;
  try { body = await response.json() as { error?: { message?: string; code?: string } }; } catch { /* not JSON */ }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  // Never advertise an OAuth resource-metadata document: there is none, and a client that follows the pointer ends up
  // probing /.well-known/oauth-protected-resource with no credentials. A plain Bearer challenge is all that is true.
  if (headers.get('www-authenticate')?.includes('resource_metadata')) headers.delete('www-authenticate');
  if (response.status === 401 && !headers.has('www-authenticate')) {
    headers.set('WWW-Authenticate', 'Bearer realm="bosun"');
  }
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: body?.error?.message ?? 'Not authenticated',
        ...(body?.error?.code ? { data: { code: body.error.code } } : {}),
      },
    },
    { status: response.status, headers },
  );
}

/** Authenticate, then hand the request to a fresh stateless MCP transport. */
export async function handleMcpRequest(request: NextRequest): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return authFailure(auth);

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, no server-side session state, a fresh transport per request (the SDK requires it).
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
    });
    const server = await createBosunMcpServer(auth, clientIp(request) ?? undefined);
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close().catch(() => undefined);
    }
  } catch (error) {
    // Never log request headers, bodies or tool arguments: they may hold an API key or a secret parameter.
    console.error('MCP request failed:', error instanceof Error ? error.name : 'unknown error');
    return jsonRpcError(500, 'Internal server error', 'INTERNAL_ERROR');
  }
}
