import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { randomUUID } from 'crypto';
import { METRIC_RE } from '@/lib/metrics/query';
import { ok, fail, failFrom } from '@/lib/api/response';

const ALERT_CONDITIONS = ['gt', 'gte', 'lt', 'lte'];
const ALERT_SEVERITIES = ['info', 'warning', 'critical'];

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializeRule(r: any) {
  let channels: unknown = [];
  try { channels = r.channels ? JSON.parse(r.channels) : []; } catch { channels = []; }
  return {
    ...r,
    threshold: Number(r.threshold),
    enabled: Number(r.enabled) === 1,
    channels,
    // Field name the alerts page uses.
    cooldown_seconds: Number(r.cooldown_sec),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const enabledOnly = new URL(request.url).searchParams.get('enabled') === 'true';
    const r = await rqlite.query(
      `SELECT a.*, s.name AS server_name FROM alert_rules a LEFT JOIN servers s ON s.id = a.server_id ${enabledOnly ? 'WHERE a.enabled = 1' : ''} ORDER BY a.name`);
    return ok({ rules: rowsToObjects(r).map(serializeRule) });
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Create a rule. Body: { name, metric, condition, threshold, server_id?,
 * severity?, cooldown_sec | cooldown_seconds, channels?, enabled? }.
 * Evaluated by the poller after every poll of each matching host.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;

  try {
    const b = await request.json();
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : '';
    if (!name) return fail('Name required');
    if (typeof b.metric !== 'string' || !METRIC_RE.test(b.metric)) return fail('Invalid metric');
    if (!ALERT_CONDITIONS.includes(b.condition)) return fail('condition must be gt, gte, lt or lte');
    const threshold = Number(b.threshold);
    if (!Number.isFinite(threshold)) return fail('threshold must be a number');
    const severity = ALERT_SEVERITIES.includes(b.severity) ? b.severity : 'warning';
    const cooldown = Math.max(30, Math.min(7 * 86400, Math.round(Number(b.cooldown_sec ?? b.cooldown_seconds ?? 300)) || 300));
    const channels = Array.isArray(b.channels) ? b.channels.filter((c: unknown) => typeof c === 'string') : Array.isArray(b.channel_ids) ? b.channel_ids : [];

    const id = randomUUID();
    await rqlite.execute(
      `INSERT INTO alert_rules (id, name, description, server_id, metric, condition, threshold, severity, channels, channel_config, cooldown_sec, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      [id, name, b.description || null, b.server_id || null, b.metric, b.condition, threshold, severity, JSON.stringify(channels), cooldown, b.enabled === false ? 0 : 1]
    );
    return ok({ id }, { status: 201 });
  } catch (error) {
    return failFrom(error);
  }
}

/** Legacy: DELETE /api/alert-rules?id=... (prefer /api/alert-rules/:id). */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return fail('ID required');
  try {
    await rqlite.execute('DELETE FROM alert_rules WHERE id = ?', [id]);
    return ok({ deleted: true });
  } catch (error) {
    return failFrom(error);
  }
}
