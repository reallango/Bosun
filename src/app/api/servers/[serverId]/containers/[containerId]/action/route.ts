import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { getAdapter } from '@/lib/ssh/adapters/factory';

export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string; containerId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { serverId, containerId } = await params;

  try {
    const body = await request.json();
    const action = body.action;

    const adapter = await getAdapter(serverId);
    if (!adapter) return NextResponse.json({ error: { message: 'Server unavailable' } }, { status: 503 });

    let result;
    switch (action) {
      case 'start':
        result = await adapter.startContainer(containerId);
        break;
      case 'stop':
        result = await adapter.stopContainer(containerId);
        break;
      case 'restart':
        result = await adapter.restartContainer(containerId);
        break;
      default:
        return NextResponse.json({ error: { message: 'Invalid action' } }, { status: 400 });
    }

    return NextResponse.json({ data: { success: result.data, error: result.error } });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}