import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { getAdapter } from '@/lib/ssh/adapters/factory';

export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { serverId } = await params;

  try {
    const adapter = await getAdapter(serverId);
    if (!adapter) return NextResponse.json({ error: { message: 'Server unavailable' } }, { status: 503 });

    const result = await adapter.listContainers();
    return NextResponse.json({ data: { containers: result.data, error: result.error } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}