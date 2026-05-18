import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { getAdapter } from '@/lib/ssh/adapters/factory';

export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string; containerId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId, containerId } = await params;
  const { searchParams } = new URL(request.url);
  const tail = parseInt(searchParams.get('tail') || '100', 10);

  try {
    const adapter = await getAdapter(serverId);
    if (!adapter) return NextResponse.json({ error: { message: 'Server unavailable' } }, { status: 503 });

    const result = await adapter.getContainerLogs(containerId, tail);
    return NextResponse.json({ data: { logs: result.data, error: result.error } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}