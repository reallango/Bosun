/** Build a Bosun MCP server for one authenticated caller. */
import type { TokenPayload } from '@/lib/auth/jwt';
import { bosunVersion } from '@/lib/update/version';
import { loadToolCatalog } from './catalog';
import { callBosunTool } from './dispatch';
import { createMcpServer } from './server';

export interface McpServerOptions {
  ip?: string;
  /** The MCP request's headers; the REST adapter forwards only Authorization and Cookie. */
  headers?: Headers;
  /** Origin used to build internal REST request URLs. */
  origin?: string;
}

export async function createBosunMcpServer(auth: TokenPayload, opts: McpServerOptions = {}) {
  const catalog = await loadToolCatalog(auth);
  const version = bosunVersion();
  return createMcpServer(
    catalog,
    (tool, args) => callBosunTool({ auth, ...opts }, tool, args),
    { name: 'bosun', version: version.commit === 'unknown' ? '0.1.0' : version.short },
  );
}
