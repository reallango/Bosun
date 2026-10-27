/**
 * Wake-on-LAN settings.
 *
 * These live in `app_config` (migration 012) rather than on a server row so the
 * server form stays unchanged: `wol.local_server_id` names the managed server
 * whose host sends the magic packet, and `wol.use_local_server` toggles that
 * path. GET is readable by any authenticated user (the wake dialog needs it);
 * PUT is admin-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { ok, fail } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'viewer');
  if (roleError) return roleError;

  try {
    const localServerId = await getConfig('wol.local_server_id');
    const useLocal = (await getConfig('wol.use_local_server')) === 'true';
    const installed = (await getConfig('wol.remote_wol_installed')) === 'true';

    let localServer: { id: string; name: string; hostname: string } | null = null;
    if (localServerId) {
      const r = await rqlite.query('SELECT id, name, hostname FROM servers WHERE id = ?', [localServerId]);
      if (r.values?.length) {
        const s = rowsToObjects(r)[0] as any;
        localServer = { id: s.id, name: s.name, hostname: s.hostname };
      }
    }

    return ok({
      local_server_id: localServerId || null,
      use_local_server: useLocal,
      remote_wol_installed: installed,
      local_server: localServer,
    });
  } catch (error) {
    console.error('WoL settings read error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return fail('Expected a JSON body', 400, 'INVALID_BODY');

    const { local_server_id, use_local_server } = body as Record<string, unknown>;

    if (local_server_id !== undefined && local_server_id !== null && local_server_id !== '') {
      const r = await rqlite.query('SELECT id FROM servers WHERE id = ?', [String(local_server_id)]);
      if (!r.values?.length) return fail('Local server not found', 404, 'SERVER_NOT_FOUND');
    }

    const previousId = await getConfig('wol.local_server_id');

    if (local_server_id !== undefined) {
      await setConfig('wol.local_server_id', local_server_id ? String(local_server_id) : '');
      // A different host has an unknown install state; clear the cache so the
      // first wake re-probes instead of trusting the old server's result.
      if ((previousId || '') !== String(local_server_id || '')) {
        await setConfig('wol.remote_wol_installed', 'false');
      }
    }

    if (use_local_server !== undefined) {
      await setConfig('wol.use_local_server', use_local_server ? 'true' : 'false');
    }

    await logAudit({
      userId: auth.userId,
      action: AuditActions.CONFIG_UPDATE,
      status: 'success',
      details: `wol.local_server_id=${local_server_id ?? '(unchanged)'}, wol.use_local_server=${use_local_server ?? '(unchanged)'}`,
    });

    const localServerId = await getConfig('wol.local_server_id');
    const useLocal = (await getConfig('wol.use_local_server')) === 'true';
    const installed = (await getConfig('wol.remote_wol_installed')) === 'true';
    return ok({
      local_server_id: localServerId || null,
      use_local_server: useLocal,
      remote_wol_installed: installed,
    });
  } catch (error) {
    console.error('WoL settings update error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}
