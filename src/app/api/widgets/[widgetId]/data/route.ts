import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { WIDGET_SECTIONS, widgetDataFromSnapshots, collectedAtFor, Sections, ServerRow } from '@/lib/widgets/snapshot-data';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import { logAudit } from '@/lib/audit/logger';

/* eslint-disable @typescript-eslint/no-explicit-any */

// custom_command runs live; cache its result briefly so several open
// dashboards do not each run it on every refresh.
const customCache = new Map<string, { at: number; data: unknown }>();
const CUSTOM_TTL_MS = 10_000;

function parseJson(v: unknown, fallback: any = {}) {
  if (typeof v !== 'string') return v ?? fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { widgetId } = await params;
  const forceParam = new URL(request.url).searchParams.get('force');
  const force = forceParam === 'true' || forceParam === 'updates';

  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const widget = rowsToObjects(widgetRes)[0] as any;
    const cfg = parseJson(widget.config);
    const srvRes = await rqlite.query(
      'SELECT id, name, hostname, platform, os_type, os_version, is_online, last_seen, last_error, poll_interval_sec FROM servers WHERE id = ?',
      [widget.server_id]);
    if (!srvRes.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const server = rowsToObjects(srvRes)[0] as unknown as ServerRow;

    if (widget.widget_type === 'custom_command') {
      // Keyed by command too, so editing the command takes effect immediately.
      const cacheKey = `${widgetId}|${cfg.command || ''}`;
      const cached = customCache.get(cacheKey);
      if (!force && cached && Date.now() - cached.at < CUSTOM_TTL_MS) {
        return NextResponse.json({ data: cached.data, collectedAt: new Date(cached.at).toISOString() });
      }
      const r = await runOnServerId(server.id, cfg.command || 'uptime', { timeoutMs: 20_000 });
      const data = { output: (r.stdout + r.stderr).slice(0, 64 * 1024), exitCode: r.exitCode, timedOut: !!r.timedOut };
      customCache.set(cacheKey, { at: Date.now(), data });
      return NextResponse.json({ data, collectedAt: new Date().toISOString() });
    }

    const sections = WIDGET_SECTIONS[widget.widget_type];
    if (!sections) {
      return NextResponse.json({ error: { message: `Unknown widget type: ${widget.widget_type}` } }, { status: 400 });
    }

    if (force) {
      // Ask the poller for an immediate full poll of this host; it picks the
      // request up within ~2 s. No SSH from the web process.
      // force=updates (OS Update Check) also runs the 6-hourly package check now.
      await rqlite.execute(
        forceParam === 'updates'
          ? 'UPDATE servers SET poll_requested_at = ?, updates_requested_at = ? WHERE id = ?'
          : 'UPDATE servers SET poll_requested_at = ? WHERE id = ?',
        forceParam === 'updates' ? [Date.now(), Date.now(), server.id] : [Date.now(), server.id]);
    }

    const snaps: Sections = {};
    if (sections.length) {
      const placeholders = sections.map(() => '?').join(',');
      const snapRes = await rqlite.query(
        `SELECT section, data, collected_at FROM host_snapshots WHERE server_id = ? AND section IN (${placeholders})`,
        [server.id, ...sections]);
      for (const [section, data, collectedAt] of snapRes.values) {
        snaps[String(section)] = { data: parseJson(data, null), collectedAt: Number(collectedAt) };
      }
    }

    const data = widgetDataFromSnapshots(widget.widget_type, snaps, server, cfg);
    const collectedAt = collectedAtFor(widget.widget_type, snaps);
    const interval = Number(server.poll_interval_sec) || 15;
    // Slow-tier sections (services, updates) are refreshed less often than the
    // poll interval; only call data stale when it is far behind.
    const staleAfterMs = Math.max(interval * 4 * 1000, 10 * 60 * 1000) * (widget.widget_type === 'os_update_check' ? 80 : 1);
    // Several widgets of one host refresh at about the poll interval; let the
    // browser reuse a response for a few seconds instead of re-querying rqlite.
    // Forced refreshes are never cached.
    const maxAge = force ? 0 : Math.max(2, Math.min(10, Math.floor(interval / 3)));
    return NextResponse.json({
      data,
      pending: data === null,
      collectedAt: collectedAt ? new Date(collectedAt).toISOString() : null,
      stale: collectedAt ? Date.now() - collectedAt > staleAfterMs : false,
      server: { is_online: !!server.is_online, last_error: server.last_error ?? null },
    }, { headers: { 'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'no-store' } });
  } catch (error) {
    console.error('Widget data error:', error);
    const status = (error as any)?.status;
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      { status: typeof status === 'number' ? status : 500 });
  }
}

// POST: os_update_check "install updates" (admin only, audited, rate limited).
export async function POST(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'admin');
  if (roleError) return roleError;
  const limited = consumeActionRateLimit(auth.userId);
  if (!limited.allowed) return NextResponse.json({ error: { message: 'Too many actions, slow down' } }, { status: 429 });
  const { widgetId } = await params;

  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const widget = rowsToObjects(widgetRes)[0] as any;
    if (widget.widget_type !== 'os_update_check') {
      return NextResponse.json({ error: { message: 'Invalid widget type for POST' } }, { status: 400 });
    }
    const { action } = await request.json();
    if (action !== 'install') return NextResponse.json({ error: { message: 'Invalid action' } }, { status: 400 });

    const srvRes = await rqlite.query('SELECT os_type, platform FROM servers WHERE id = ?', [widget.server_id]);
    const [osType, platform] = (srvRes.values?.[0] || []) as string[];
    if (platform === 'windows') return NextResponse.json({ error: { message: 'Not supported on Windows' } }, { status: 400 });
    const rhel = /rhel|centos|fedora|rocky|alma/.test(osType || '');
    // Non-interactive sudo: fails fast instead of hanging on a password prompt.
    const cmd = rhel
      ? 'sudo -n dnf -y upgrade 2>&1 || sudo -n yum -y update 2>&1'
      : 'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade 2>&1';
    const started = Date.now();
    const r = await runOnServerId(widget.server_id, `${cmd}; echo "BOSUN_EXIT=$?"; [ -f /var/run/reboot-required ] && echo REBOOT_REQUIRED`, { timeoutMs: 30 * 60 * 1000 });
    const exit = Number((r.stdout.match(/BOSUN_EXIT=(\d+)/) || [])[1] ?? r.exitCode);
    const success = exit === 0;
    await logAudit({ userId: auth.userId, serverId: widget.server_id, action: 'server.updates_install', category: 'server',
      status: success ? 'success' : 'failure', durationMs: Date.now() - started });
    await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), widget.server_id]);
    return NextResponse.json({
      data: {
        success,
        message: !success
          ? (/a password is required|sudo:/.test(r.stdout) ? 'Passwordless sudo is required for the SSH user' : `Update failed (exit ${exit})`)
          : r.stdout.includes('REBOOT_REQUIRED') ? 'Updates installed. System needs a reboot.' : 'Updates installed',
        output: r.stdout.slice(-4000),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : String(error) } }, { status: 500 });
  }
}
