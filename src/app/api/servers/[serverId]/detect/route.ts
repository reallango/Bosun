import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { detectServerOs } from '@/lib/ssh/detect';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { serverId } = await params;
    const srv = await rqlite.query('SELECT * FROM servers WHERE id=?', [serverId]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    const s = rowsToObjects(srv)[0] as any;
    if (!s.ssh_key_id) return NextResponse.json({ error: { message: 'No SSH key' } }, { status: 400 });
    const keyR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [s.ssh_key_id]);
    if (!keyR.values?.length) return NextResponse.json({ error: { message: 'Key not found' } }, { status: 404 });
    const pk = decrypt(keyR.values[0][0] as string, process.env.MASTER_KEY || '');
    const cfg: SSHConnectionConfig = { host: s.hostname, port: s.ssh_port || 22, username: s.ssh_user, privateKey: pk };

    const data = await detectServerOs(serverId, s, cfg);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_DETECT, status: 'success', details: `${data.os_type} ${data.os_version}` });
    return NextResponse.json({ data });
  } catch (error) {
    console.error('OS detect error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
