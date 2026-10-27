import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { requireLevel } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const payload = await requireLevel(request, 'admin');
    if (payload instanceof NextResponse) return payload;
    const { keyId } = await params;
    const r = await rqlite.query('SELECT id,name,public_key,fingerprint,key_type,created_at FROM ssh_keys WHERE id=?', [keyId]);
    if (!r.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    return NextResponse.json({ data: rowsToObjects(r)[0] });
  } catch (error) {
    console.error('SSH key get error:', error);
    return internalError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { keyId: string } }) {
  try {
    const payload = await requireLevel(request, 'admin');
    if (payload instanceof NextResponse) return payload;
    const { keyId } = await params;
    const inUse = await rqlite.query('SELECT id FROM servers WHERE ssh_key_id=?', [keyId]);
    if (inUse.values?.length) return NextResponse.json({ error: { message: 'Key in use by server(s)' } }, { status: 400 });
    await rqlite.execute('DELETE FROM ssh_keys WHERE id=?', [keyId]);
    await logAudit({ userId: payload.userId, action: AuditActions.SSH_KEY_DELETE, status: 'success' });
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('SSH key delete error:', error);
    return internalError(error);
  }
}