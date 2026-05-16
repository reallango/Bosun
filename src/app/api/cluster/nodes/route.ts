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
    
    const nodes = [
      { id: status.node, address: status.address, is_leader: status.is_leader, reachable: true },
      ...(status.followers || []).map((n: any) => ({ id: n.id, address: n.address, is_leader: n.is_leader, reachable: n.reachable }))
    ];

    return NextResponse.json({ data: nodes });
  } catch (error) {
    console.error('Cluster nodes error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}