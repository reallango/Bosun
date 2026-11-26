import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { DeployError, detectBosunRunning, getDeploy, nodeNameFrom, startBosunDeploy } from '@/lib/servers/deploy-bosun';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import * as clusterConfig from '@/lib/cluster/config';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ serverId: string }> };

/**
 * The last (or current) deployment of Bosun to this server, whether Bosun already runs there (`running`), and the defaults
 * for a new one. Signed-in Full access only.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    const srv = rowsToObjects(await rqlite.query('SELECT name FROM servers WHERE id = ?', [serverId]))[0];
    if (!srv) return fail('Server not found', 404, 'NOT_FOUND');
    const { running, check_error } = await detectBosunRunning(serverId);
    return ok({
      deploy: await getDeploy(serverId),
      running,
      check_error,
      defaults: { node_name: nodeNameFrom(String(srv.name)), cluster: clusterConfig.effectiveClusterConfig().cluster_ready },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Deploy Bosun to this server: POST { mode: 'join' | 'standalone', node_name?, confirm: true }. Answers 202 at once; the
 * progress is in GET and the outcome in the bell. Needs Docker on the server and a widget that manages stacks.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  let body: { mode?: unknown; node_name?: unknown; confirm?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.confirm !== true) return fail('Send confirm: true to deploy Bosun to this server', 400, 'CONFIRM_REQUIRED');
  if (body.mode !== 'join' && body.mode !== 'standalone') return fail('mode must be "join" or "standalone"', 400, 'VALIDATION');
  if (body.node_name !== undefined && typeof body.node_name !== 'string') return fail('node_name must be text', 400, 'VALIDATION');
  try {
    const d = await startBosunDeploy(auth, serverId, { mode: body.mode, nodeName: body.node_name as string | undefined }, clientIp(request) ?? undefined);
    return ok({ deploy: d }, { status: 202 });
  } catch (error) {
    if (error instanceof DeployError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}
