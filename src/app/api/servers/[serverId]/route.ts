import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt } from '@/lib/crypto/keys';
import { sshPool, SSHConnectionConfig } from '@/lib/ssh/connection-pool';
import { AdapterFactory } from '@/lib/ssh/adapters/factory';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });

    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token', code: 'INVALID_TOKEN' } }, { status: 401 });

    const result = await rqlite.query(`
      SELECT s.*, k.name as ssh_key_name, k.public_key, k.fingerprint
      FROM servers s
      LEFT JOIN ssh_keys k ON s.ssh_key_id = k.id
      WHERE s.id = '${params.serverId}'
    `);

    if (result.values.length === 0) {
      return NextResponse.json({ error: { message: 'Server not found', code: 'NOT_FOUND' } }, { status: 404 });
    }

    const row = result.values[0];
    return NextResponse.json({
      data: {
        id: row[0], name: row[1], hostname: row[2], ssh_port: row[3], ssh_user: row[4], ssh_key_id: row[5],
        os_type: row[6], os_version: row[7], os_codename: row[8], kernel_version: row[9], notes: row[10],
        is_online: !!row[11], last_seen: row[12], cpu_model: row[13], cpu_cores: row[14],
        total_ram_mb: row[15], tags: row[16] ? JSON.parse(row[16] as string) : [],
        created_at: row[17], updated_at: row[18],
        ssh_key_name: row[19], public_key: row[20], fingerprint: row[21]
      }
    });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });

    const updates: string[] = [];
    const values: any[] = [];
    const body = await request.json();

    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.hostname !== undefined) { updates.push('hostname = ?'); values.push(body.hostname); }
    if (body.ssh_port !== undefined) { updates.push('ssh_port = ?'); values.push(body.ssh_port); }
    if (body.ssh_user !== undefined) { updates.push('ssh_user = ?'); values.push(body.ssh_user); }
    if (body.ssh_key_id !== undefined) { updates.push('ssh_key_id = ?'); values.push(body.ssh_key_id); }
    if (body.notes !== undefined) { updates.push('notes = ?'); values.push(body.notes); }
    if (body.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(body.tags)); }

    if (updates.length === 0) {
      return NextResponse.json({ error: { message: 'No fields to update', code: 'INVALID_INPUT' } }, { status: 400 });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(params.serverId);

    await rqlite.execute(
      `UPDATE servers SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    await logAudit({ userId: payload.userId, serverId: params.serverId, action: AuditActions.SERVER_UPDATE, status: 'success' });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('Server update error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });

    await rqlite.execute(`DELETE FROM servers WHERE id = ?`, [params.serverId]);
    await logAudit({ userId: payload.userId, serverId: params.serverId, action: AuditActions.SERVER_DELETE, status: 'success' });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}