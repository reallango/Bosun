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

export type ToolKind = 'core' | 'dataset' | 'action';

/** A tool plus the Bosun metadata needed to run it. */
export interface CatalogTool extends McpTool {
  kind: ToolKind;
  /** Core tools only. */
  coreName?: string;
  /** Widget tools only. */
  widgetType?: string;
  widgetDisplayName?: string;
  datasetId?: string;
  actionId?: string;
  actionKind?: 'command' | 'terminal' | 'script' | 'screen';
  requiresConfirm?: boolean;
  job?: boolean;
  permission?: string;
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
