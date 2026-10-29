import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { querySeries, listMetrics, describeMetric, describeFromDefinitions, RANGES } from '@/lib/metrics/query';
import { serverVisible } from '@/lib/permissions/effective';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { ok, fail, failFrom } from '@/lib/api/response';

/** Labels and units that package widgets give their tracked metrics. */
async function definitions() {
  try {
    return rowsToObjects(await rqlite.query('SELECT pattern, label, unit FROM metric_definitions WHERE label IS NOT NULL OR unit IS NOT NULL')) as unknown as
      { pattern: string; label: string | null; unit: string | null }[];
  } catch {
    return [];
  }
}

/**
 * GET /api/metrics?serverId=...&metrics=cpu.usage,mem.used_pct&range=24h
 *   -> downsampled series (avg/min/max per bucket)
 * GET /api/metrics?serverId=...  (no metrics)
 *   -> the metrics that have data for that server, with labels and units
 * A server a person may not see (denied "See a server") has no readable history either.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const sp = new URL(request.url).searchParams;
  const serverId = sp.get('serverId');
  if (!serverId) return fail('serverId is required');
  try {
    if (!(await serverVisible(auth, serverId))) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const defs = await definitions();
    const describe = (m: string) => describeFromDefinitions(defs, m, describeMetric(m));
    const metrics = (sp.get('metrics') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!metrics.length) {
      const list = await listMetrics(serverId);
      return ok({ metrics: list.map(m => ({ metric: m, ...describe(m) })), ranges: Object.keys(RANGES) });
    }
    const result = await querySeries(serverId, metrics, sp.get('range') || '24h');
    return ok({ ...result, series: result.series.map(s => ({ ...s, ...describe(s.metric) })) });
  } catch (error) {
    return failFrom(error);
  }
}
