/** The MCP protocol wiring: a low-level SDK server whose tool list is built per caller. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CatalogTool, McpToolCatalog, ToolResult } from './types';
import { errorResult } from './format';
import { errorText } from './errors';

export type ToolHandler = (tool: CatalogTool, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ServerInfo {
  name: string;
  version: string;
}

export function createMcpServer(catalog: McpToolCatalog, call: ToolHandler, info: ServerInfo): Server {
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.tools.map(t => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const tool = catalog.byName.get(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`) as CallToolResult;
    try {
      return await call(tool, (args ?? {}) as Record<string, unknown>) as CallToolResult;
    } catch (error) {
      return errorResult(errorText(error)) as CallToolResult;
    }
  });

  return server;
}
