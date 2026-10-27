/**
 * Wake-on-LAN settings.
 *
 *  - sender: 'auto' (from the server this Bosun node's container runs on),
 *    'local_server' (always from wol.local_server_id) or 'container'.
 *  - node host: per-node mapping (app_config wol.node_host.<NODE_NAME>) that
 *    overrides detection; null clears it so the host is detected again.
 *
 * GET is readable by any signed-in user (the wake buttons use it); PUT is admin-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail, failFrom } from '@/lib/api/response';
import { nodeName, detectNodeHost, getNodeHostMapping, setNodeHostMapping, resolveWolSender } from '@/lib/network/node-host';

async function serverBrief(id: string | null) {
  if (!id) return null;
  const r = await rqlite.query('SELECT id, name, hostname FROM servers WHERE id = ?', [id]);
  return (rowsToObjects(r)[0] as { id: string; name: string; hostname: string } | undefined) || null;
}

async function snapshot() {
  const sender = await resolveWolSender();
  const [mapped, detected, localId] = await Promise.all([
    getNodeHostMapping(), detectNodeHost().catch(() => null), getConfig('wol.local_server_id'),
  ]);
  const senderServer = await serverBrief(sender.serverId);
  return {
    sender: sender.mode,
    node_name: nodeName(),
    node_host_mapped: await serverBrief(mapped),
    node_host_detected: await serverBrief(detected),
    local_server_id: localId || null,
    local_server: await serverBrief(localId || null),
    // Who sends right now, and whether wakeonlan was found there last time.
    effective_sender: senderServer ? { ...senderServer, source: sender.source } : null,
    remote_wol_installed: senderServer ? (await getConfig(`wol.installed.${senderServer.id}`)) === 'true' : false,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return ok(await snapshot());
  } catch (error) {
    return failFrom(error);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return fail('Expected a JSON body', 400, 'INVALID_BODY');
    const exists = async (id: unknown) => !!(await serverBrief(String(id)));

    if (body.sender !== undefined) {
      if (!['auto', 'local_server', 'container'].includes(String(body.sender))) return fail('sender must be auto, local_server or container');
      await setConfig('wol.sender', String(body.sender));
    }
    if (body.local_server_id !== undefined) {
      if (body.local_server_id && !(await exists(body.local_server_id))) return fail('Local server not found', 404);
      await setConfig('wol.local_server_id', body.local_server_id ? String(body.local_server_id) : '');
    }
    if (body.node_host_server_id !== undefined) {
      if (body.node_host_server_id && !(await exists(body.node_host_server_id))) return fail('Server not found', 404);
      await setNodeHostMapping(body.node_host_server_id ? String(body.node_host_server_id) : null);
    }
    await logAudit({ userId: auth.userId, action: AuditActions.CONFIG_UPDATE, status: 'success',
      details: JSON.stringify({ wol: body, node: nodeName() }) });
    return ok(await snapshot());
  } catch (error) {
    return failFrom(error);
  }
}
