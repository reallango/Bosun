/**
 * OpenAPI 3.0 description of the Bosun API surface that scripts and AI agents use: the fixed
 * endpoints plus one operation per installed package widget action and data source, generated
 * from the widgets' specs so it always matches what is installed. Pure.
 */
import type { ParamSpec, WidgetSpec } from '@/lib/widgets/runtime/spec';

export interface OpenApiWidget {
  type: string;
  packageId: string;
  displayName: string;
  spec: WidgetSpec;
  /** Permission label by id, for descriptions. */
  permissionLabels: Record<string, string>;
}

type Json = Record<string, unknown>;

const serverIdParam = { name: 'serverId', in: 'path', required: true, schema: { type: 'string' }, description: 'Server id (GET /api/servers)' };

function paramSchema(p: ParamSpec): Json {
  if (p.type === 'boolean') return { type: 'boolean', ...(p.description ? { description: p.description } : {}) };
  if (p.type === 'number') return { type: p.integer ? 'integer' : 'number', minimum: p.min, maximum: p.max, ...(p.description ? { description: p.description } : {}) };
  return {
    type: 'string', maxLength: p.maxLength,
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(p.values ? { enum: p.values } : {}),
    ...(p.description ? { description: p.description } : {}),
  };
}

const errorResponses: Json = {
  '400': { description: 'Invalid request (bad parameters, or confirmation missing)' },
  '401': { description: 'Missing or invalid API key' },
  '403': { description: 'The API key lacks the required permission' },
  '404': { description: 'Unknown server, widget or action' },
  '409': { description: 'Not available for this host (for example Windows)' },
  '429': { description: 'Rate limited' },
};

export function buildOpenApi(widgets: OpenApiWidget[], serverUrl = '/'): Json {
  const paths: Json = {
    '/api/servers': {
      get: { operationId: 'listServers', summary: 'List servers', tags: ['Servers'], responses: { '200': { description: 'Servers' }, '401': errorResponses['401'] } },
    },
    '/api/servers/{serverId}/exec': {
      post: {
        operationId: 'execAsServiceAccount', summary: 'Run a command as the privileged service account', tags: ['Commands'],
        description: 'Needs the `commands.run` permission (Full access by default).',
        parameters: [serverIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', maxLength: 4000 } } } } } },
        responses: { '200': { description: 'Output and exit code' }, ...errorResponses },
        'x-bosun-permission': 'commands.run',
      },
    },
    '/api/servers/{serverId}/shell/exec': {
      post: {
        operationId: 'execAsShellAccount', summary: 'Run a command as the non-admin shell account', tags: ['Commands'],
        description: 'API keys only. The account has no sudo and no Docker access. Needs the `shell.user` permission.',
        parameters: [serverIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', maxLength: 4000 } } } } } },
        responses: { '200': { description: 'Output and exit code' }, ...errorResponses },
        'x-bosun-permission': 'shell.user',
      },
    },
    '/api/servers/{serverId}/terminal': {
      post: {
        operationId: 'createTerminalToken', summary: 'Get a single-use token for an API terminal WebSocket', tags: ['Terminal'],
        description: 'Connect to `/ws/api-terminal?token=...` within the token lifetime. `target: host` needs `shell.user`; `target: container` needs `docker.shell`.',
        parameters: [serverIdParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['target'], properties: { target: { type: 'string', enum: ['host', 'container'] }, container: { type: 'string' } } } } } },
        responses: { '200': { description: 'Token and WebSocket path' }, ...errorResponses },
      },
    },
  };

  for (const w of widgets) {
    const tag = `${w.displayName} (${w.packageId})`;
    const dataPerm = w.spec.data.permission;
    paths[`/api/servers/{serverId}/widget-data/${w.type}`] = {
      get: {
        operationId: `widgetData_${w.type}`, summary: `Data of the ${w.displayName} widget`, tags: [tag],
        description: dataPerm ? `Needs the "${w.permissionLabels[dataPerm] ?? dataPerm}" permission.` : 'Any API key.',
        parameters: [serverIdParam, { name: 'force', in: 'query', required: false, schema: { type: 'string', enum: ['1'] }, description: 'Run the command again instead of using the cache (needs permission to refresh the server)' }],
        responses: { '200': { description: 'The rows or values the widget shows' }, ...errorResponses },
        ...(dataPerm ? { 'x-bosun-permission': dataPerm } : {}),
      },
    };
    for (const a of w.spec.actions) {
      const names = Object.keys(a.params);
      const props: Json = { ...(names.length ? { params: { type: 'object', required: names, additionalProperties: false, properties: Object.fromEntries(names.map(n => [n, paramSchema(a.params[n])])) } } : {}) };
      if (a.confirm) props.confirm = { type: 'boolean', enum: [true], description: 'Must be true: this action asks for confirmation in the widget' };
      const required = [...(names.length ? ['params'] : []), ...(a.confirm ? ['confirm'] : [])];
      paths[`/api/servers/{serverId}/widget-actions/${w.type}/${a.id}`] = {
        post: {
          operationId: `widgetAction_${w.type}_${a.id}`, summary: a.label, tags: [tag],
          description: [
            a.description,
            `Needs the "${w.permissionLabels[a.permission] ?? a.permission}" permission. Runs on the host as the ${a.as === 'service' ? 'privileged service account' : 'non-admin shell account'}.`,
            a.confirm ? `Asks for confirmation: ${a.confirm.title}` : undefined,
          ].filter(Boolean).join(' '),
          parameters: [serverIdParam],
          ...(Object.keys(props).length ? { requestBody: { required: required.length > 0, content: { 'application/json': { schema: { type: 'object', ...(required.length ? { required } : {}), properties: props } } } } } : {}),
          responses: { '200': { description: 'success, output, error, exitCode, timedOut' }, ...errorResponses },
          'x-bosun-permission': a.permission,
          'x-bosun-runs-as': a.as,
        },
      };
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Bosun API',
      version: '1',
      description: 'Endpoints for scripts and AI agents. Authenticate with an API key (Settings → API Access): `Authorization: Bearer bosun_...`. '
        + 'Package widget actions are listed per installed widget; each needs the permission it names, granted through a permission group.',
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Bosun API key' } } },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
