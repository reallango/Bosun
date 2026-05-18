import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { SSHConnectionPool } from '@/lib/ssh/connection-pool';

const pool = new SSHConnectionPool();

export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { serverId } = await params;

  try {
    const body = await request.json();
    const { command } = body;

    if (!command) {
      return NextResponse.json({ error: { message: 'Command required' } }, { status: 400 });
    }

    // Get server and key
    const srvR = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!srvR.values?.length) {
      return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    }
    const srv = rowsToObjects(srvR)[0] as any;

    if (!srv.ssh_key_id) {
      return NextResponse.json({ error: { message: 'No SSH key configured' } }, { status: 400 });
    }

    const kR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id = ?', [srv.ssh_key_id]);
    if (!kR.values?.length) {
      return NextResponse.json({ error: { message: 'SSH key not found' } }, { status: 404 });
    }

    const { decrypt } = await import('@/lib/crypto/keys');
    const pk = decrypt(kR.values[0][0] as string, process.env.MASTER_KEY || '');
    if (!pk) {
      return NextResponse.json({ error: { message: 'Failed to decrypt SSH key' } }, { status: 500 });
    }

    const sshConfig = {
      host: srv.hostname,
      port: srv.ssh_port || 22,
      username: srv.ssh_user,
      privateKey: pk
    };

    // Execute command
    const result = await pool.executeCommand(serverId, sshConfig, command);

    return NextResponse.json({
      data: {
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode
      }
    });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}