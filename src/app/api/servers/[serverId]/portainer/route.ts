import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { logAudit } from '@/lib/audit/logger';
import { rqlite } from '@/lib/db/rqlite-client';
import { deleteConnection, getConnection, listEndpoints, normalizeUrl, PortainerError, saveConnection } from '@/lib/portainer/client';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ serverId: string }> };

async function serverExists(id: string) {
  return !!(await rqlite.query('SELECT 1 FROM servers WHERE id = ?', [id])).values?.length;
}

/** The Portainer connection of a server (never the key itself). Signed-in Full access only. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    if (!(await serverExists(serverId))) return fail('Server not found', 404, 'NOT_FOUND');
    const c = await getConnection(serverId);
    return ok({ portainer: c ? { url: c.url, insecure: c.insecure, endpoint_id: c.endpointId, has_key: c.hasKey } : null });
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Save and test: { url, api_key? (kept when left out), insecure?, endpoint_id? }. Portainer is asked for its environments
 * with the key; with exactly one, it is chosen; with several, endpoint_id picks one (the answer lists them).
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  let body: { url?: unknown; api_key?: unknown; insecure?: unknown; endpoint_id?: unknown };
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  try {
    if (!(await serverExists(serverId))) return fail('Server not found', 404, 'NOT_FOUND');
    const url = normalizeUrl(body.url);
    if (!url) return fail('url must be the address of Portainer, e.g. https://192.168.1.160:9443', 400, 'VALIDATION');
    const apiKey = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : null;
    if (apiKey && (apiKey.length > 300 || /[\s\u0000-\u001f]/.test(apiKey))) return fail('That does not look like a Portainer API key', 400, 'VALIDATION');
    const existing = await getConnection(serverId);
    if (!apiKey && !existing?.hasKey) return fail('An API key is needed (Portainer: My account > Access tokens)', 400, 'VALIDATION');
    const insecure = body.insecure === true;
    const probe = { url, insecure, endpointId: null as number | null };
    const endpoints = (await listEndpoints(serverId, probe, apiKey ?? undefined)).filter(e => e.Type === 1 || e.Type === 2);
    let endpointId: number | null = null;
    if (body.endpoint_id !== undefined && body.endpoint_id !== null) {
      endpointId = Number(body.endpoint_id);
      if (!endpoints.some(e => e.Id === endpointId)) return fail('That Portainer environment does not exist', 400, 'VALIDATION');
    } else if (endpoints.length === 1) endpointId = endpoints[0].Id;
    await saveConnection(serverId, { url, insecure, endpointId }, apiKey);
    await logAudit({ userId: auth.userId, serverId, action: 'portainer.connect', category: 'stacks', status: 'success', ipAddress: clientIp(request) ?? undefined, details: `${url}${insecure ? ' (self-signed accepted)' : ''}` }).catch(() => undefined);
    return ok({ portainer: { url, insecure, endpoint_id: endpointId, has_key: true }, endpoints });
  } catch (error) {
    if (error instanceof PortainerError) return fail(error.message, error.status, error.code);
    return failFrom(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;
  try {
    await deleteConnection(serverId);
    await logAudit({ userId: auth.userId, serverId, action: 'portainer.disconnect', category: 'stacks', status: 'success', ipAddress: clientIp(request) ?? undefined }).catch(() => undefined);
    return ok({ removed: true });
  } catch (error) {
    return failFrom(error);
  }
}
