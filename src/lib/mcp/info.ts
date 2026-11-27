/** Human-readable discovery document for GET /api/mcp (no MCP headers) and GET /api/mcp/info. */
import type { NextRequest } from 'next/server';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

/** The address the client used, behind nginx or a tunnel (request.url is Next's internal address). */
export function requestOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const proto = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : request.nextUrl.protocol === 'https:' ? 'https' : 'http';
  const rawHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host') || request.nextUrl.host;
  const host = rawHost.replace(/[^A-Za-z0-9.:\[\]-]/g, '').slice(0, 255) || request.nextUrl.host;
  return `${proto}://${host}`;
}

export function mcpInfo(origin: string) {
  const endpoint = `${origin}/api/mcp`;
  return {
    name: 'Bosun MCP',
    description: 'Model Context Protocol endpoint for Bosun. Orient, read widget data, run widget actions, wait for jobs and access requests, and manage schedules with the same permissions as the REST API.',
    endpoint,
    transport: 'streamable-http',
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    authentication: {
      type: 'bearer',
      header: 'Authorization',
      scheme: 'Bearer',
      keyPrefix: 'bosun_',
      note: 'Create an API key under Settings → API access. A signed-in browser session cookie also works.',
    },
    tools: {
      core: [
        'bosun_overview', 'servers_list', 'server_get', 'job_wait', 'job_log',
        'access_whoami', 'access_request', 'access_request_wait',
        'schedules_list', 'schedule_create', 'schedule_run_now',
        'update_status', 'notifications_list',
      ],
      widget: 'One tool per installed widget dataset (<widget_type>__<dataset>) and runnable action (<widget_type>__<action>), filtered to what the caller may use.',
    },
    connect: {
      claude_code: `claude mcp add --transport http bosun ${endpoint} --header "Authorization: Bearer bosun_..."`,
      claude_desktop: {
        mcpServers: {
          bosun: {
            command: 'npx',
            args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization: Bearer bosun_...'],
          },
        },
      },
      curl: `curl -sS -X POST ${endpoint} -H "Authorization: Bearer bosun_..." -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
    docs: 'README.md#mcp-for-ai-agents',
  };
}
