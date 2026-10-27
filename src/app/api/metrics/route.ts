import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { querySeries, listMetrics, describeMetric, RANGES } from '@/lib/metrics/query';
import { ok, fail, failFrom } from '@/lib/api/response';

/**
 * GET /api/metrics?serverId=...&metrics=cpu.usage,mem.used_pct&range=24h
 *   -> downsampled series (avg/min/max per bucket)
 * GET /api/metrics?serverId=...  (no metrics)
 *   -> the metrics that have data for that server, with labels and units
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const sp = new URL(request.url).searchParams;
  const serverId = sp.get('serverId');
  if (!serverId) return fail('serverId is required');
  try {
    const metrics = (sp.get('metrics') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!metrics.length) {
      const list = await listMetrics(serverId);
      return ok({ metrics: list.map(m => ({ metric: m, ...describeMetric(m) })), ranges: Object.keys(RANGES) });
    }
    const result = await querySeries(serverId, metrics, sp.get('range') || '24h');
    return ok({ ...result, series: result.series.map(s => ({ ...s, ...describeMetric(s.metric) })) });
  } catch (error) {
    return failFrom(error);
  }
}
