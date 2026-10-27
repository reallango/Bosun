import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { enableClustering, removeNode, convertToSingle, createJoinCode } from '@/lib/cluster/control';
import { logAudit } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

/**
 * Cluster management (admin, explicit confirm):
 *   { action: 'enable', adv_host, node_id? }   single node -> cluster-ready (restarts rqlite)
 *   { action: 'join_code' }                     code for adding a node (contains secrets)
 *   { action: 'remove', node_id }               remove a member from the cluster
 *   { action: 'to_single' }                     make this node a one-node cluster
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  let body: { action?: string; adv_host?: string; node_id?: string; confirm?: boolean };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.confirm !== true) return fail('Confirmation required', 400, 'CONFIRM_REQUIRED');
  const audit = (status: 'success' | 'failure', details: unknown) =>
    logAudit({ userId: auth.userId, action: `cluster.${body.action}`, category: 'cluster', status, details: JSON.stringify(details) });

  try {
    switch (body.action) {
      case 'enable': {
        await enableClustering(String(body.adv_host || '').trim(), body.node_id ? String(body.node_id).trim() : undefined);
        await audit('success', { adv_host: body.adv_host, node_id: body.node_id }).catch(() => undefined);
        return ok({ restarting: true });
      }
      case 'join_code': {
        const r = await createJoinCode();
        await audit('success', { members: r.members.map(m => m.id), expires_at: r.expires_at });
        return ok(r);
      }
      case 'remove': {
        await removeNode(String(body.node_id || ''));
        await audit('success', { node_id: body.node_id });
        return ok({ removed: body.node_id });
      }
      case 'to_single': {
        const r = await convertToSingle();
        await audit('success', r).catch(() => undefined);
        return ok({ ...r, restarting: r.method === 'forced' });
      }
      default:
        return fail('Unknown action');
    }
  } catch (error) {
    await audit('failure', { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    return failFrom(error);
  }
}
