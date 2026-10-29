import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { ok, fail, failFrom } from '@/lib/api/response';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { publicSpec } from '@/lib/widgets/runtime/spec';

/**
 * How to draw a package widget and which actions it offers, for the browser. The commands that
 * implement the data and the actions, and the account they run as, are never sent.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { type } = await params;
  try {
    const loaded = await loadWidgetSpec(type);
    if (!loaded) return fail('Unknown widget type', 404, 'NOT_FOUND');
    return ok({ type, packageId: loaded.packageId, spec: publicSpec(loaded.spec) }, { headers: { 'Cache-Control': 'private, max-age=30' } });
  } catch (error) {
    return failFrom(error);
  }
}
