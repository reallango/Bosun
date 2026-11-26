import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { rqlite } from '@/lib/db/rqlite-client';
import { serverVisible } from '@/lib/permissions/effective';
import { listSetups } from '@/lib/servers/setup';

export const dynamic = 'force-dynamic';

/**
 * "Set up this server": what installed widgets can install on this host and whether it is there now. Each entry needs the
 * permission of its widget's detect dataset; installing runs the widget's action through the usual widget-actions route.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    const exists = await rqlite.query('SELECT 1 FROM servers WHERE id = ?', [serverId]);
    if (!exists.values?.length || !(await serverVisible(auth, serverId))) return fail('Server not found', 404, 'NOT_FOUND');
    return ok({ setups: await listSetups(auth, serverId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failFrom(error);
  }
}
