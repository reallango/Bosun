/** Build a Bosun MCP server for one authenticated caller. */
import type { TokenPayload } from '@/lib/auth/jwt';
import { bosunVersion } from '@/lib/update/version';
import { loadToolCatalog } from './catalog';
import { callBosunTool } from './dispatch';
import { createMcpServer } from './server';

export async function createBosunMcpServer(auth: TokenPayload, ip?: string) {
  const catalog = await loadToolCatalog(auth);
  const version = bosunVersion();
  return createMcpServer(
    catalog,
    (tool, args) => callBosunTool({ auth, ip }, tool, args),
    { name: 'bosun', version: version.commit === 'unknown' ? '0.1.0' : version.short },
  );
}
