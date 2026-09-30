import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { getSystemHealth } from '@/lib/health/system-health';
import { ok, fail } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'viewer');
  if (roleError) return roleError;

  try {
    return ok(await getSystemHealth());
  } catch (error) {
    console.error('System health error:', error);
    return fail('Internal server error', 500, 'INTERNAL_ERROR');
  }
}
