import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { keyId } = await params;
    const r = await rqlite.query('SELECT id,name,public_key,fingerprint,key_type,created_at FROM ssh_keys WHERE id=?', [keyId]);
    if (!r.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    return NextResponse.json({ data: rowsToObjects(r)[0] });
  } catch (error) {
    console.error('SSH key get error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload||payload.role!=='admin') return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
    const { keyId } = await params;
    const inUse = await rqlite.query('SELECT id FROM servers WHERE ssh_key_id=?', [keyId]);
    if (inUse.values?.length) return NextResponse.json({ error: { message: 'Key in use by server(s)' } }, { status: 400 });
    await rqlite.execute('DELETE FROM ssh_keys WHERE id=?', [keyId]);
    await logAudit({ userId: payload.userId, action: AuditActions.SSH_KEY_DELETE, status: 'success' });
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('SSH key delete error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}