import { NextRequest, NextResponse } from 'next/server';
import { clientIp, requireUserLevel } from '@/lib/auth/middleware';
import { invalidateApiKeyCache } from '@/lib/auth/api-key-auth';
import { API_KEY_COLUMNS, toApiKeyDto } from '@/lib/auth/api-key-dto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { fail, internalError, ok } from '@/lib/api/response';

type Params = { params: Promise<{ keyId: string }> };

async function findKey(keyId: string) {
  const r = await rqlite.query(
    `SELECT ${API_KEY_COLUMNS}, u.username AS created_by_username
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.id = ?`, [keyId]);
  const row = rowsToObjects(r)[0];
  return row ? toApiKeyDto(row) : null;
}

/** Revoke a key: { revoked: true }. Revocation cannot be undone. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { keyId } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return fail('Invalid JSON body'); }
  if (body.revoked !== true) return fail('Only { "revoked": true } is supported', 400, 'VALIDATION');
  try {
    const key = await findKey(keyId);
    if (!key) return fail('API key not found', 404, 'NOT_FOUND');
    if (key.revoked_at) return ok({ apiKey: key });
    await rqlite.execute('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [new Date().toISOString(), keyId]);
    invalidateApiKeyCache();
    await logAudit({
      userId: auth.userId, action: AuditActions.API_KEY_REVOKE, category: 'api_key', status: 'success',
      details: `${key.name} (prefix ${key.prefix})`, ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ apiKey: await findKey(keyId) });
  } catch (error) {
    console.error('API key revoke error:', error);
    return internalError(error);
  }
}

/** Delete a key permanently. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await requireUserLevel(request, 'admin');
  if (auth instanceof NextResponse) return auth;
  const { keyId } = await params;
  try {
    const key = await findKey(keyId);
    if (!key) return fail('API key not found', 404, 'NOT_FOUND');
    await rqlite.executeBatch([
      { sql: 'DELETE FROM api_key_groups WHERE api_key_id = ?', params: [keyId] },
      { sql: 'DELETE FROM api_keys WHERE id = ?', params: [keyId] },
    ], { transaction: true });
    invalidateApiKeyCache();
    await logAudit({
      userId: auth.userId, action: AuditActions.API_KEY_DELETE, category: 'api_key', status: 'success',
      details: `${key.name} (prefix ${key.prefix})`, ipAddress: clientIp(request) ?? undefined,
    });
    return ok({ success: true });
  } catch (error) {
    console.error('API key delete error:', error);
    return internalError(error);
  }
}
