import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { requirePermission } from '@/lib/permissions/authorize';
import { containerLogs } from '@/lib/docker/actions';
import { ok, failFrom } from '@/lib/api/response';

export async function GET(request: NextRequest, { params }: { params: Promise<{ serverId: string; containerId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  // Logs can contain secrets; operators and admins only.
  const { serverId, containerId } = await params;
  const roleError = await requirePermission(auth, 'docker.logs', serverId);
  if (roleError) return roleError;
  const tail = parseInt(new URL(request.url).searchParams.get('tail') || '200', 10) || 200;
  try {
    return ok({ logs: await containerLogs(serverId, containerId, tail) });
  } catch (error) {
    return failFrom(error);
  }
}
