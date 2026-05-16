import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: { message: 'Admin only', code: 'FORBIDDEN' } }, { status: 403 });
    }

    const status = await rqlite.getStatus();
    return NextResponse.json({
      data: {
        leader: status.is_leader ? status.node : status.followers.find(f => f.is_leader)?.id || null,
        nodes: status.followers.map(n => ({ id: n.id, address: n.address, is_leader: n.is_leader, reachable: n.reachable })),
        raft_index: status.raft_index
      }
    });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}