/**
 * MCP tool catalog: the fixed core tools plus one tool per installed widget dataset and runnable action.
 *
 * Widget tools are generated from the same specs `/api/openapi.json` uses, so Bosun's own code never names a widget.
 * `canUse` is evaluated per caller: `tools/list` only shows what the caller may use on at least one server.
 */
import type { WidgetSpec } from '@/lib/widgets/runtime/spec';
import { targetLabel } from '@/lib/widgets/runtime/resources';
import type { CatalogTool, JsonSchema, ObjectJsonSchema } from './types';
import { actionInputSchema, datasetInputSchema } from './schema';

export interface WidgetToolSource {
  type: string;
  displayName: string;
  packageId: string;
  spec: WidgetSpec;
  permissionLabels: Record<string, string>;
  permissionRisks: Record<string, 'low' | 'medium' | 'high'>;
}

export interface ToolUse {
  /** The action or dataset needs the permission for the whole server (no stack/container limit can satisfy it). */
  wholeServerOnly: boolean;
}

export type CanUse = (permission: string, use: ToolUse) => boolean;

/** A widget type whose installed package needs a newer Bosun on this node: its tools cannot be built from the spec. */
export interface BlockedWidgetSource {
  type: string;
  displayName: string;
  reason: string;
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function takeName(used: Set<string>, base: string, suffix: 'data' | 'action'): string | null {
  if (TOOL_NAME_RE.test(base) && !used.has(base)) { used.add(base); return base; }
  const fallback = `${base}_${suffix}`;
  if (TOOL_NAME_RE.test(fallback) && !used.has(fallback)) { used.add(fallback); return fallback; }
  for (let i = 2; i < 100; i++) {
    const name = `${base}_${suffix}${i}`;
    if (TOOL_NAME_RE.test(name) && !used.has(name)) { used.add(name); return name; }
  }
  return null;
}

export function buildWidgetTools(sources: WidgetToolSource[], canUse: CanUse, blocked: BlockedWidgetSource[] = []): CatalogTool[] {
  const out: CatalogTool[] = [];
  const used = new Set<string>();
  for (const b of blocked) {
    const name = takeName(used, `${b.type}__unavailable`, 'data');
    if (!name) continue;
    out.push({
      kind: 'blocked',
      name,
      title: `${b.displayName}: unavailable`,
      description: `${b.reason} This node cannot read the package's tools until every node in the cluster runs the newer Bosun.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      widgetType: b.type,
      widgetDisplayName: b.displayName,
      blockedReason: b.reason,
    });
  }
  for (const w of sources) {
    for (const [datasetId, ds] of Object.entries(w.spec.datasets ?? {})) {
      const wholeServerOnly = !ds.target && !ds.resources;
      if (!canUse(ds.permission, { wholeServerOnly })) continue;
      const script = w.spec.scripts?.[ds.script];
      if (!script) continue;
      const name = takeName(used, `${w.type}__${datasetId}`, 'data');
      if (!name) continue;
      const label = w.permissionLabels[ds.permission] ?? ds.permission;
      out.push({
        kind: 'dataset',
        name,
        title: `${w.displayName}: ${datasetId}`,
        description: [
          `Read the "${datasetId}" dataset of the ${w.displayName} widget.`,
          `Needs the "${label}" permission.`,
          ds.target ? `Acts on ${targetLabel(ds.target)}; pass "${ds.target.param}".` : undefined,
          ds.resources ? 'Rows are filtered to the stacks/containers you may see.' : undefined,
          'Use servers_list to find server ids.',
        ].filter(Boolean).join(' '),
        inputSchema: datasetInputSchema(script.params),
        annotations: { readOnlyHint: true, openWorldHint: false },
        widgetType: w.type,
        widgetDisplayName: w.displayName,
        datasetId,
        permission: ds.permission,
      });
    }

    for (const a of w.spec.actions) {
      if (a.kind === 'screen') continue;
      const wholeServerOnly = !a.target;
      if (!canUse(a.permission, { wholeServerOnly })) continue;
      const name = takeName(used, `${w.type}__${a.id}`, 'action');
      if (!name) continue;
      const label = w.permissionLabels[a.permission] ?? a.permission;
      const risk = w.permissionRisks[a.permission];
      const destructive = a.confirm?.destructive === true || risk === 'high';
      out.push({
        kind: 'action',
        name,
        title: `${w.displayName}: ${a.label}`,
        description: [
          `${a.label}.`,
          a.description,
          `Needs the "${label}" permission.`,
          a.kind === 'terminal'
            ? 'Returns a single-use token for an interactive terminal (connect to /ws/api-terminal?token=...).'
            : `Runs as the ${a.as === 'service' ? 'privileged service account' : 'non-admin shell account'}.`,
          a.confirm ? `Asks for confirmation: ${a.confirm.title}${a.confirm.text ? ` — ${a.confirm.text}` : ''} Send confirm: true.` : undefined,
          a.job ? 'Starts a job: use job_wait with the returned job_id to follow it.' : undefined,
          a.target ? `Acts on ${targetLabel(a.target)}; pass "${a.target.param}".` : undefined,
          'Use servers_list to find server ids.',
        ].filter(Boolean).join(' '),
        inputSchema: actionInputSchema(a),
        annotations: {
          readOnlyHint: false,
          openWorldHint: true,
          ...(destructive ? { destructiveHint: true } : {}),
        },
        widgetType: w.type,
        widgetDisplayName: w.displayName,
        actionId: a.id,
        actionKind: a.kind,
        requiresConfirm: !!a.confirm,
        job: !!a.job,
        permission: a.permission,
      });
    }
  }
  return out;
}

const noArgs = (): ObjectJsonSchema => ({ type: 'object', properties: {}, additionalProperties: false });

const serverId: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Server id (call servers_list to find one).',
};

const jobId: JsonSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 64,
  description: 'Job id returned by a widget action that starts a job.',
};

const credentialObject: JsonSchema = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Field id -> value. Secrets are write-only and never returned by any read.',
};

const credentialServers: JsonSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 128 },
  description: 'Servers the entry applies to (empty: every server, where the kind allows it).',
};

const credentialWidgetType: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description: 'The widget type that belongs to the package (servers_list is unrelated; see the widget pages).',
};

/** The fixed tools. Compact by default; `detail: true` returns the full object. */
export function coreTools(): CatalogTool[] {
  return [
    {
      kind: 'core',
      coreName: 'bosun_overview',
      name: 'bosun_overview',
      title: 'Bosun overview',
      description: 'One call to orient: Bosun version, cluster nodes and every server you may see with its key metrics.',
      inputSchema: noArgs(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'servers_list',
      name: 'servers_list',
      title: 'List servers',
      description: 'Servers you may see: id, name, online state and platform. Pass detail: true for the full rows.',
      inputSchema: {
        type: 'object',
        properties: { detail: { type: 'boolean', description: 'Return the full server objects.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'server_get',
      name: 'server_get',
      title: 'Get a server',
      description: 'One server by id. Compact by default; pass detail: true for every stored field.',
      inputSchema: {
        type: 'object',
        properties: { server_id: serverId, detail: { type: 'boolean', description: 'Return the full server object.' } },
        required: ['server_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'job_wait',
      name: 'job_wait',
      title: 'Wait for a job',
      description: 'Wait until a widget job finishes (or the timeout passes). Returns status, message and the last steps. Use job_log for the full output.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: jobId,
          timeout: { type: 'integer', minimum: 1, maximum: 120, description: 'Seconds to wait (default 30, at most 120).' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'job_log',
      name: 'job_log',
      title: 'Read a job log',
      description: 'The full log of a widget job you may see.',
      inputSchema: {
        type: 'object',
        properties: { job_id: jobId },
        required: ['job_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'access_whoami',
      name: 'access_whoami',
      title: 'What am I allowed to do?',
      description: 'What this API key or signed-in user holds, which servers it may see, and its access requests (same data as GET /api/access).',
      inputSchema: noArgs(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'access_request',
      name: 'access_request',
      title: 'Ask for access',
      description: 'Create an access request (same body as POST /api/access-requests): a permission grant or one run of a widget action.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['grant', 'one_time'], description: 'A permission grant, or one run of a widget action.' },
          permission: { type: 'string', description: 'For kind=grant: a permission id from access_whoami.' },
          server_id: { type: 'string', description: 'The server (leave out for a global grant).' },
          resource: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['stack', 'container'] },
              name: { type: 'string', description: 'A name, or a prefix ending in *.' },
            },
            required: ['kind', 'name'],
            additionalProperties: false,
            description: 'Limit the grant to one stack or container.',
          },
          duration_hours: { type: 'integer', minimum: 1, maximum: 8760, description: 'Hours until the grant expires (leave out for permanent).' },
          reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Why you need it (required).' },
          widget_type: { type: 'string', description: 'For kind=one_time: the widget type.' },
          action_id: { type: 'string', description: 'For kind=one_time: the action id.' },
          params: { type: 'object', additionalProperties: true, description: 'For kind=one_time: the action parameters.' },
        },
        required: ['kind', 'reason'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'access_request_wait',
      name: 'access_request_wait',
      title: 'Wait for an access request',
      description: 'Long-poll an access request until it is decided (at most 50 seconds per call; repeat while it is pending).',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', minLength: 1, maxLength: 64 },
          timeout: { type: 'integer', minimum: 1, maximum: 50, description: 'Seconds to wait (default 30, at most 50).' },
        },
        required: ['request_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'schedules_list',
      name: 'schedules_list',
      title: 'List schedules',
      description: 'Schedules you may manage, with their cron expression, time zone, next run and last run.',
      inputSchema: {
        type: 'object',
        properties: { detail: { type: 'boolean', description: 'Return the full schedule objects.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'schedule_create',
      name: 'schedule_create',
      title: 'Create a schedule',
      description: 'Create a schedule (same body as POST /api/schedules). Needs "Manage schedules" and the permission the widget declared for the run.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          widget_type: { type: 'string', minLength: 1, maxLength: 60 },
          schedule_kind: { type: 'string', minLength: 1, maxLength: 40 },
          server_id: { type: 'string', minLength: 1, maxLength: 60 },
          resource_kind: { type: 'string', enum: ['stack', 'container'], description: 'Only for a schedule kind that runs on one stack or container.' },
          resource_name: { type: 'string', maxLength: 128 },
          cron: { type: 'string', minLength: 1, maxLength: 100 },
          timezone: { type: 'string', minLength: 1, maxLength: 64, description: 'An IANA name such as Europe/Berlin.' },
          enabled: { type: 'boolean' },
          options: {
            type: 'object',
            additionalProperties: true,
            description: 'Dataset runs take options.args; action runs take options.params; options.keepRuns is 10-1000.',
          },
        },
        required: ['name', 'widget_type', 'schedule_kind', 'server_id', 'cron', 'timezone'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'schedule_run_now',
      name: 'schedule_run_now',
      title: 'Run a schedule now',
      description: 'Run one schedule immediately, as you (same as POST /api/schedules/:id/run).',
      inputSchema: {
        type: 'object',
        properties: { schedule_id: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['schedule_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    {
      kind: 'core',
      coreName: 'update_status',
      name: 'update_status',
      title: 'Update status',
      description: 'Settings → Updates status: versions per node, the newest image, problems and the current rollout (Full access only).',
      inputSchema: noArgs(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'notifications_list',
      name: 'notifications_list',
      title: 'Recent notifications',
      description: 'Recent bell items you may see (newest first).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many to return (default 25).' },
          unread_only: { type: 'boolean', description: 'Only unread items.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'credentials_list',
      name: 'credentials_list',
      title: 'List package credentials',
      description: 'Credential entries of a widget package (for example Git access or backup destinations): public fields, whether each secret is set, the server scope and last use. Never a secret value.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_type: credentialWidgetType,
          kind: { type: 'string', description: 'One credential kind; leave out for every kind you may view.' },
          server_id: { ...serverId, description: 'Only entries that apply to this server.' },
        },
        required: ['widget_type'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'credentials_create',
      name: 'credentials_create',
      title: 'Create a package credential',
      description: 'Create one credential entry (same body as POST /api/widgets/:type/credentials). Needs the credential kind\'s permission on every server it applies to.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_type: credentialWidgetType,
          kind: { type: 'string', minLength: 1, maxLength: 40 },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          fields: credentialObject,
          secrets: credentialObject,
          servers: credentialServers,
          is_default: { type: 'boolean', description: 'Make it the default for its servers (when the kind has a per-server default).' },
        },
        required: ['widget_type', 'kind', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'credentials_update',
      name: 'credentials_update',
      title: 'Update a package credential',
      description: 'Edit one credential entry (same body as PUT /api/widgets/:type/credentials). Leave a secret out (or send "") to keep it unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_type: credentialWidgetType,
          kind: { type: 'string', minLength: 1, maxLength: 40 },
          id: { type: 'string', minLength: 1, maxLength: 64 },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          fields: credentialObject,
          secrets: credentialObject,
          servers: credentialServers,
          is_default: { type: 'boolean' },
        },
        required: ['widget_type', 'kind', 'id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      kind: 'core',
      coreName: 'credentials_delete',
      name: 'credentials_delete',
      title: 'Delete a package credential',
      description: 'Delete one credential entry (same as DELETE /api/widgets/:type/credentials).',
      inputSchema: {
        type: 'object',
        properties: {
          widget_type: credentialWidgetType,
          kind: { type: 'string', minLength: 1, maxLength: 40 },
          id: { type: 'string', minLength: 1, maxLength: 64 },
        },
        required: ['widget_type', 'kind', 'id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
  ];
}
