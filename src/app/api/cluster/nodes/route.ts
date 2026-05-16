import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const port = process.env.RQLITE_HTTP_PORT || '4001';
    const res = await fetch(`http://localhost:${port}/status`);
    const d = await res.json();
    const nodes = Object.entries(d?.store?.raft?.servers||{}).map(([id,n]:[string,any]) => ({ id, address: n.addr||id, is_leader: !!n.leader, reachable: true }));
    if (!nodes.length) nodes.push({ id: d?.store?.node_id||'local', address: `localhost:${port}`, is_leader: true, reachable: true });
    return NextResponse.json({ data: nodes });
  } catch (error) {
    console.error('Cluster nodes error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}