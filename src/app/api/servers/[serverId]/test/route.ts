import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, SSHConnectionConfig } from '@/lib/ssh/connection-pool';
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

    // Get server
    const serverResult = await rqlite.query(`SELECT hostname, ssh_port, ssh_user, ssh_key_id FROM servers WHERE id = '${params.serverId}'`);
    if (serverResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'Server not found', code: 'NOT_FOUND' } }, { status: 404 });
    }

    const [hostname, sshPort, sshUser, sshKeyId] = serverResult.values[0];
    if (!sshKeyId) {
      return NextResponse.json({ error: { message: 'No SSH key configured', code: 'NO_SSH_KEY' } }, { status: 400 });
    }

    // Get SSH key
    const keyResult = await rqlite.query(`SELECT private_key_enc FROM ssh_keys WHERE id = '${sshKeyId}'`);
    if (keyResult.values.length === 0) {
      return NextResponse.json({ error: { message: 'SSH key not found', code: 'KEY_NOT_FOUND' } }, { status: 404 });
    }

    const masterKey = process.env.MASTER_KEY;
    if (!masterKey) {
      return NextResponse.json({ error: { message: 'MASTER_KEY not configured', code: 'NOT_CONFIGURED' } }, { status: 500 });
    }

    const privateKey = decrypt(keyResult.values[0][0] as string, masterKey);

    const sshConfig: SSHConnectionConfig = {
      host: hostname as string,
      port: sshPort as number,
      username: sshUser as string,
      privateKey
    };

    const startTime = Date.now();
    const result = await sshPool.executeCommand(params.serverId, sshConfig, 'echo test && uname -a');
    const durationMs = Date.now() - startTime;

    await logAudit({
      userId: payload.userId,
      serverId: params.serverId,
      action: AuditActions.SERVER_TEST,
      status: result.exitCode === 0 ? 'success' : 'failure',
      details: result.stdout,
      durationMs
    });

    if (result.exitCode !== 0) {
      return NextResponse.json({
        error: { message: 'SSH connection failed', code: 'SSH_FAILED', details: result.stderr }
      }, { status: 400 });
    }

    return NextResponse.json({
      data: {
        success: true,
        output: result.stdout,
        exitCode: result.exitCode,
        durationMs
      }
    });
  } catch (error) {
    console.error('SSH test error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}