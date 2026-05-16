import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { AdapterFactory } from '@/lib/ssh/adapters/factory';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });
    }

    const serverResult = await rqlite.query(`SELECT hostname, ssh_port, ssh_user, ssh_key_id FROM servers WHERE id = '${params.serverId}'`);
    if (serverResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'Server not found', code: 'NOT_FOUND' } }, { status: 404 });
    }

    const [hostname, sshPort, sshUser, sshKeyId] = serverResult.values[0];
    if (!sshKeyId) {
      return NextResponse.json({ error: { message: 'No SSH key configured', code: 'NO_SSH_KEY' } }, { status: 400 });
    }

    const keyResult = await rqlite.query(`SELECT private_key_enc FROM ssh_keys WHERE id = '${sshKeyId}'`);
    if (keyResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'SSH key not found', code: 'KEY_NOT_FOUND' } }, { status: 404 });
    }

    const masterKey = process.env.MASTER_KEY;
    if (!masterKey) {
      return NextResponse.json({ error: { message: 'MASTER_KEY not configured', code: 'NOT_CONFIGURED' } }, { status: 500 });
    }

    const privateKey = decrypt(keyResult.values[0][0] as string, masterKey);

    const server = {
      id: params.serverId,
      name: '',
      hostname: hostname as string,
      ssh_port: sshPort as number,
      ssh_user: sshUser as string,
      ssh_key_id: sshKeyId as string,
      os_type: null,
      os_version: null,
      os_codename: null
    };

    const detectResult = await AdapterFactory.detectOS(sshPool, server, privateKey);

    await rqlite.execute(
      `UPDATE servers SET os_type = ?, os_version = ?, os_codename = ?, kernel_version = ?, cpu_model = ?, cpu_cores = ?, total_ram_mb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [detectResult.os_type, detectResult.os_version, detectResult.os_codename, detectResult.kernel_version, detectResult.cpu_model, detectResult.cpu_cores, detectResult.total_ram_mb, params.serverId]
    );

    await logAudit({
      userId: payload.userId,
      serverId: params.serverId,
      action: AuditActions.SERVER_DETECT,
      status: 'success',
      details: JSON.stringify(detectResult)
    });

    return NextResponse.json({ data: detectResult });
  } catch (error) {
    console.error('OS detect error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}