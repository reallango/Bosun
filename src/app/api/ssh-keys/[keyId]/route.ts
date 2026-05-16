import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload) {
      return NextResponse.json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } }, { status: 401 });
    }

    const result = await rqlite.query(
      `SELECT id, name, fingerprint, key_type, created_at, updated_at FROM ssh_keys WHERE id = '${params.keyId}'`
    );

    if (result.values.length === 0) {
      return NextResponse.json({ error: { message: 'Key not found', code: 'NOT_FOUND' } }, { status: 404 });
    }

    const row = result.values[0];
    return NextResponse.json({
      data: {
        id: row[0], name: row[1], fingerprint: row[2], key_type: row[3], created_at: row[4], updated_at: row[5]
      }
    });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });
    }

    // Check if key is in use
    const inUse = await rqlite.query(
      `SELECT COUNT(*) FROM servers WHERE ssh_key_id = '${params.keyId}'`
    );

    if (inUse.values[0]?.[0] > 0) {
      return NextResponse.json({ error: { message: 'Cannot delete: key is in use by servers', code: 'KEY_IN_USE' } }, { status: 400 });
    }

    await rqlite.execute(`DELETE FROM ssh_keys WHERE id = ?`, [params.keyId]);

    await logAudit({
      userId: payload.userId,
      action: AuditActions.SSH_KEY_DELETE,
      status: 'success'
    });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}