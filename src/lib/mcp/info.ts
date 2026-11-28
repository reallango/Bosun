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
    description: 'Model Context Protocol endpoint for Bosun. Every REST endpoint an API key may call is also an MCP tool: servers, power, widgets, schedules, users, cluster, database, settings, host commands and terminal sessions. Each tool calls the same route handler (or library function) with the caller\'s own credentials, so permissions, rate limits and audit logging match the REST API.',
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
      host: [
        'server_command', 'container_exec',
        'terminal_open', 'terminal_send', 'terminal_read', 'terminal_screen', 'terminal_close',
      ],
      rest: 'One tool per REST route an API key may call: servers, power, wake, refresh, metrics, dashboards, widget instances and settings, widget definitions and runtime, widget jobs and packages (including package secrets, which are set but never returned), schedules, notifications and channels, alert rules, server groups, SSH keys, permission groups and grants, users and API keys, audit logs, cluster, database, SMTP and WOL settings, system update (rollout and rollback), Portainer, and access requests. Destructive tools require confirm: true. Each tool calls the same route handler with the caller\'s Authorization or Cookie, so permission checks, rate limits and audit logging are identical.',
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
