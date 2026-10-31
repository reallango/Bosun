import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getWidgetDefinitions, resolveWidgetDefinition } from '@/components/widgets/registry-loader';
import { ok, fail, failFrom } from '@/lib/api/response';
import { sanitizeCustomWidget, withoutSpec } from '@/lib/widgets/custom-widget-input';
import { hasPermission } from '@/lib/permissions/authorize';
import { loadWidgetSpec } from '@/lib/widgets/runtime/execute';

/**
 * GET /api/widget-definitions?serverId=<id>
 *   Built-in + enabled custom definitions supported by that server's platform
 *   (everything without serverId). Cached briefly: definitions only change
 *   when an admin edits a custom widget, and the Add Widget picker reopens often.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const serverId = new URL(request.url).searchParams.get('serverId');
    let platform: string | undefined;
    if (serverId) {
      const srv = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
      if (!srv.values?.length) return fail('Server not found', 404);
      platform = (srv.values[0][0] as string) || 'linux';
    }
    let definitions = await getWidgetDefinitions(platform);
    // Package widgets are offered only to those who hold their data permission (for that server, when one is given).
    if (auth.role !== 'admin') {
      const keep: typeof definitions = [];
      for (const d of definitions) {
        const perm = d.packageId ? (await loadWidgetSpec(d.type))?.spec.data.permission : null;
        if (!perm || await hasPermission(auth, perm, serverId)) keep.push(d);
      }
      definitions = keep;
    }
    return NextResponse.json(
      { data: { definitions, platform: platform ?? null } },
      { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (error) {
    return failFrom(error);
  }
}
