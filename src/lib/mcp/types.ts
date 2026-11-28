/** Shapes shared by the Bosun MCP endpoint (JSON Schema based, no Zod dependency). */

export type JsonSchema = Record<string, unknown>;

/** The top level of an MCP tool input schema is always an object. */
export interface ObjectJsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: ObjectJsonSchema;
  annotations?: ToolAnnotations;
}

export type ToolKind = 'core' | 'host' | 'rest' | 'dataset' | 'action' | 'blocked';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A tool that invokes one REST route handler with the caller's own credentials. The route keeps doing the
 * authentication, permission checks, rate limiting, audit logging and validation, so the MCP path cannot drift
 * from the REST path.
 */
export interface RestQueryParam {
  /** Tool argument name. */
  arg: string;
  /** Query parameter name, when it differs from `arg`. */
  param?: string;
  /** How a boolean is written; routes differ ('true' vs '1'). */
  trueValue?: string;
  falseValue?: string;
}

export interface RestToolSpec {
  /** Route template under /api, e.g. "servers/[serverId]". */
  route: string;
  method: HttpMethod;
  /** Route parameter -> tool argument name, e.g. { serverId: 'server_id' }. */
  path?: Record<string, string>;
  /** Tool arguments sent as query parameters. */
  query?: Array<string | RestQueryParam>;
  /** Which arguments become the JSON body: none, everything not used by path/query/confirm, or everything. */
  body?: 'none' | 'rest' | 'all';
  /** Use this argument's object as the whole JSON body (e.g. a settings map the route reads at the top level). */
  bodyRoot?: string;
  /** Keep `confirm` in the body because the route itself checks it (power, cluster actions, ...). */
  keepConfirm?: boolean;
  /** Binary requests/responses that need special encoding. */
  binary?: 'form-file' | 'raw';
}

/** A tool plus the Bosun metadata needed to run it. */
export interface CatalogTool extends McpTool {
  kind: ToolKind;
  /** Core tools only. */
  coreName?: string;
  /** Host tools only (server_command, terminal_*, container_exec). */
  hostName?: string;
  /** REST-adapter tools only. */
  rest?: RestToolSpec;
  /** The REST route+method pairs this tool covers, for the parity test (e.g. "GET servers/[serverId]"). */
  routes?: string[];
  /** Confirmation text shown when a destructive tool is called without confirm: true. */
  confirmText?: string;
  /** Widget tools only. */
  widgetType?: string;
  widgetDisplayName?: string;
  datasetId?: string;
  actionId?: string;
  actionKind?: 'command' | 'terminal' | 'script' | 'screen';
  requiresConfirm?: boolean;
  job?: boolean;
  permission?: string;
  /** A `blocked` tool: why this node cannot use the widget (an installed package needs a newer Bosun here). */
  blockedReason?: string;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolCatalog {
  tools: CatalogTool[];
  byName: Map<string, CatalogTool>;
}

export function buildCatalog(tools: CatalogTool[]): McpToolCatalog {
  return { tools, byName: new Map(tools.map(t => [t.name, t])) };
}
