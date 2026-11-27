import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './server';
import { buildCatalog, type CatalogTool } from './types';
import { coreTools } from './tools';

const widgetTool: CatalogTool = {
  kind: 'dataset',
  name: 'sample_widget__rows',
  description: 'Rows',
  inputSchema: {
    type: 'object',
    properties: { server_id: { type: 'string' } },
    required: ['server_id'],
    additionalProperties: false,
  },
  widgetType: 'sample_widget',
  datasetId: 'rows',
};

describe('MCP server wiring', () => {
  it('lists the catalog and calls a tool through the SDK client', async () => {
    const catalog = buildCatalog([...coreTools(), widgetTool]);
    const server = createMcpServer(
      catalog,
      async (tool, args) => ({ content: [{ type: 'text', text: `${tool.name}:${String(args.server_id)}` }] }),
      { name: 'bosun', version: '1.0.0' },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const list = await client.listTools();
      expect(list.tools.map(t => t.name)).toContain('bosun_overview');
      expect(list.tools.map(t => t.name)).toContain('sample_widget__rows');

      const result = await client.callTool({ name: 'sample_widget__rows', arguments: { server_id: 's1' } });
      expect(result.content).toEqual([{ type: 'text', text: 'sample_widget__rows:s1' }]);

      const unknown = await client.callTool({ name: 'not_a_tool', arguments: {} });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
