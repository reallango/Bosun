import { getMasterKey } from '@/lib/secrets';
import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { requireLevel } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const payload = await requireLevel(request, 'admin');
    if (payload instanceof NextResponse) return payload;
    const { serverId } = await params;
    const srv = await rqlite.query('SELECT * FROM servers WHERE id=?', [serverId]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    const s = rowsToObjects(srv)[0] as any;
    if (!s.ssh_key_id) return NextResponse.json({ error: { message: 'No SSH key assigned' } }, { status: 400 });
    const keyR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [s.ssh_key_id]);
    if (!keyR.values?.length) return NextResponse.json({ error: { message: 'Key not found' } }, { status: 404 });
    const pk = decrypt(keyR.values[0][0] as string, getMasterKey());
    const cfg: SSHConnectionConfig = { host: s.hostname, port: s.ssh_port||22, username: s.ssh_user, privateKey: pk };
    const t0 = Date.now();
    const res = await sshPool.executeCommand(serverId, cfg, 'echo ok');
    const ms = Date.now() - t0;
    await rqlite.execute("UPDATE servers SET is_online=1, last_seen=CURRENT_TIMESTAMP WHERE id=?", [serverId]);
    await logAudit({ userId: payload.userId, serverId, action: AuditActions.SERVER_TEST, status: 'success', durationMs: ms });
    return NextResponse.json({ data: { success: true, latencyMs: ms } });
  } catch (error) {
    console.error('SSH test error:', error);
    return internalError(error);
  }
}