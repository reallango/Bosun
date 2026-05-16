import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest, { params }: { params: { serverId: string } }) {
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
      `SELECT is_online, last_seen, cpu_model, cpu_cores, total_ram_mb, os_type, os_version FROM servers WHERE id = '${params.serverId}'`
    );

    if (result.values.length === 0) {
      return NextResponse.json({ error: { message: 'Server not found', code: 'NOT_FOUND' } }, { status: 404 });
    }

    const row = result.values[0];
    return NextResponse.json({
      data: {
        is_online: !!row[0],
        last_seen: row[1],
        cpu_model: row[2],
        cpu_cores: row[3],
        total_ram_mb: row[4],
        os_type: row[5],
        os_version: row[6]
      }
    });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}