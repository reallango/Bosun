import { internalError } from '@/lib/api/response';
import { NextRequest, NextResponse } from 'next/server';
import { requireLevel } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest, { params }: { params: { serverId: string } }) {
  try {
    const payload = await requireLevel(request, 'viewer');
    if (payload instanceof NextResponse) return payload;
    const r = await rqlite.query('SELECT is_online, last_seen FROM servers WHERE id=?', [params.serverId]);
    if (!r.values?.length) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    return NextResponse.json({ data: { is_online: !!r.values[0][0], last_seen: r.values[0][1] } });
  } catch (error) {
    console.error('Health error:', error);
    return internalError(error);
  }
}