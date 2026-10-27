import { NextRequest } from 'next/server';
import { rqlite } from '@/lib/db/rqlite-client';
import { getConfig } from '@/lib/db/migrations';
import { joinCluster } from '@/lib/cluster/control';
import { effectiveClusterConfig } from '@/lib/cluster/config';
import { checkLoginRateLimit, recordLoginAttempt } from '@/lib/utils/rate-limiter';
import { ok, fail, failFrom } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

/**
 * Is this node fresh (no setup, no users, not clustered)? Only then may the
 * unauthenticated setup page join it to a cluster, which discards its local
 * database.
 */
async function freshNode(): Promise<{ fresh: boolean; reason?: string }> {
  if ((await getConfig('app.setup_complete')) === 'true') return { fresh: false, reason: 'Setup is already complete on this node' };
  try {
    const users = await rqlite.query('SELECT COUNT(*) FROM users');
    if (Number(users.values?.[0]?.[0] || 0) > 0) return { fresh: false, reason: 'This node already has user accounts' };
    const nodes = await rqlite.getNodes();
    if (nodes.filter(n => n.voter).length > 1) return { fresh: false, reason: 'This node is already part of a cluster' };
  } catch {
    return { fresh: false, reason: 'Database not ready yet' };
  }
  return { fresh: true };
}

/** Setup page status: can this node be joined, and how far is a join. */
export async function GET() {
  const eff = effectiveClusterConfig();
  let ready = false;
  let voters = 0;
  let users = 0;
  try {
    ready = await rqlite.isReady();
    if (ready) {
      voters = (await rqlite.getNodes()).filter(n => n.voter).length;
      users = Number((await rqlite.query('SELECT COUNT(*) FROM users')).values?.[0]?.[0] || 0);
    }
  } catch { /* restarting */ }
  const f = ready ? await freshNode() : { fresh: false };
  return ok({
    node_id: eff.node_id,
    adv_host: eff.adv_host,
    joinable: f.fresh,
    reason: f.reason ?? null,
    // During/after a join: joined once the cluster (with its users) is visible here.
    db_ready: ready,
    voters,
    joined: ready && voters > 1 && users > 0,
    pending: eff.pending,
  });
}

/** Join this fresh node to a cluster: { code, adv_host, node_id }. */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const limit = checkLoginRateLimit(ip);
  if (!limit.allowed) return fail('Too many attempts', 429, 'RATE_LIMITED');
  recordLoginAttempt(ip);
  const f = await freshNode();
  if (!f.fresh) return fail(f.reason || 'This node cannot be joined', 409, 'NOT_FRESH');
  let body: { code?: string; adv_host?: string; node_id?: string };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    const members = await joinCluster(String(body.code || ''), String(body.adv_host || '').trim(), String(body.node_id || '').trim());
    return ok({ joining: true, members: members.map(m => m.id) });
  } catch (error) {
    return failFrom(error);
  }
}
