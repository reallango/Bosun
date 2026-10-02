import { NextRequest, NextResponse } from 'next/server';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { SSHConnectionPool } from '@/lib/ssh/connection-pool';
import { isWindows } from '@/lib/ssh/platform';
import { getLinuxWidgetData } from '@/lib/linux/collectors';
import { getWindowsWidgetData, powershellCommand } from '@/lib/windows/collectors';
import { getCustomWidgetData } from '@/lib/custom-widgets/collectors';
import { resolveWidgetDefinition } from '@/components/widgets/registry-loader';

const pool = new SSHConnectionPool();

export async function GET(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
    const auth = await requireAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { widgetId } = await params;
    const searchParams = new URL(request.url).searchParams;
    const forceRefresh = searchParams.get('force') === 'true';
  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    const widget = rowsToObjects(widgetRes)[0] as any;
    const wCfg = widget.config ? (typeof widget.config==='string'?JSON.parse(widget.config||'{}'):widget.config) : {};
    const srvR = await rqlite.query('SELECT * FROM servers WHERE id=?', [widget.server_id]);
    if (!srvR.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const srv = rowsToObjects(srvR)[0] as any;

    // The definition decides how data is collected: built-in types come from
    // the compiled registry, custom types from `custom_widgets`. An unknown type
    // is a real error (not a 200 placeholder) so the widget surfaces it.
    const def = await resolveWidgetDefinition(widget.widget_type);
    if (!def) {
      return NextResponse.json({ error: { message: `Unknown widget type: ${widget.widget_type}` } }, { status: 400 });
    }

    // Per-instance override wins over the type default: the widget settings
    // dialog can turn database caching on/off for a single instance. NULL means
    // "inherit the definition's use_database".
    const pcRes = await rqlite.query('SELECT use_database FROM widget_polling_config WHERE widget_id = ?', [widgetId]);
    const instanceUseDb = pcRes.values?.length && pcRes.values[0][0] !== null ? Number(pcRes.values[0][0]) !== 0 : undefined;
    const useDatabase = instanceUseDb !== undefined ? instanceUseDb : def.useDatabase !== false;

    // Server Summary is served live from the servers row so it always reflects
    // the current is_online / os_type (the poller no longer caches it).
    if (widget.widget_type === 'server_summary') {
      return NextResponse.json({ data: { is_online: !!srv.is_online, hostname: srv.hostname, os_type: srv.os_type, os_version: srv.os_version, name: srv.name } });
    }

    // Try cache first (unless forceRefresh or the widget opted out of the DB)
    if (!forceRefresh && useDatabase) {
      const cacheRes = await rqlite.query(`
        SELECT data, collected_at, expires_at, storage_mode
        FROM widget_data_cache
        WHERE widget_type = ? AND server_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY collected_at DESC LIMIT 1
      `, [widget.widget_type, widget.server_id]);

      if (cacheRes.values?.length) {
        const [data, collectedAt, expiresAt, storageMode] = cacheRes.values[0];
        const isStale = expiresAt && new Date(expiresAt as string) < new Date();
        return NextResponse.json({
          data: JSON.parse(data as string),
          cachedAt: collectedAt,
          stale: isStale
        });
      }
    }

    // Fall back to live SSH
    if (!srv.ssh_key_id) return NextResponse.json({ error: { message: 'No SSH key' } }, { status: 400 });
    const kR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [srv.ssh_key_id]);
    if (!kR.values?.length) return NextResponse.json({ error: { message: 'Key not found' } }, { status: 404 });
    const { decrypt } = await import('@/lib/crypto/keys');
    const pk = decrypt(kR.values[0][0] as string, process.env.MASTER_KEY||'');
    const sshCfg = { host: srv.hostname, port: srv.ssh_port||22, username: srv.ssh_user, privateKey: pk };
    const run = async (cmd: string) => pool.executeCommand(srv.id, sshCfg, cmd);
    const runPS = async (script: string) => pool.executeCommand(srv.id, sshCfg, powershellCommand(script));
    const cfg = { ...wCfg, server: srv };

    const platform = isWindows(srv) ? 'windows' : 'linux';
    const data = def.isCustom
        ? await getCustomWidgetData(widget.widget_type, { platform, run, runPS, cfg })
        : platform === 'windows'
            ? await getWindowsWidgetData(widget.widget_type, runPS, cfg)
            : await getLinuxWidgetData(widget.widget_type, run, cfg);

    if (data === undefined) {
        return NextResponse.json({ error: { message: `No collector for type: ${widget.widget_type} on ${platform}` } }, { status: 400 });
    }
    return NextResponse.json({ data });
  } catch (error) {
    console.error('Widget data error:', error);
    // Surface collection failures (SSH timeout, parse error, ...) as a real
    // error so the widget shows a retryable message instead of a silent
    // "Awaiting connection..." placeholder that hides the cause.
    return NextResponse.json({ error: { message: String(error).substring(0, 200) } }, { status: 502 });
  }
}

// POST handler for os_update_check actions
export async function POST(request: NextRequest, { params }: { params: Promise<{ widgetId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { widgetId } = await params;

  try {
    const widgetRes = await rqlite.query('SELECT * FROM widgets WHERE id = ?', [widgetId]);
    if (!widgetRes.values?.length) {
      return NextResponse.json({ error: { message: 'Widget not found' } }, { status: 404 });
    }
    const widget = rowsToObjects(widgetRes)[0] as any;

    if (widget.widget_type !== 'os_update_check') {
      return NextResponse.json({ error: { message: 'Invalid widget type for POST' } }, { status: 400 });
    }

    const { action } = await request.json();

    if (action === 'install') {
      const srvR = await rqlite.query('SELECT * FROM servers WHERE id=?', [widget.server_id]);
      const srv = rowsToObjects(srvR)[0] as any;

      if (!srv.ssh_key_id) {
        return NextResponse.json({ error: { message: 'No SSH key' } }, { status: 400 });
      }

      const kR = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id=?', [srv.ssh_key_id]);
      const { decrypt } = await import('@/lib/crypto/keys');
      const pk = decrypt(kR.values[0][0] as string, process.env.MASTER_KEY || '');
      const sshCfg = { host: srv.hostname, port: srv.ssh_port || 22, username: srv.ssh_user, privateKey: pk };

      const osType = srv.os_type || 'ubuntu';
      let installCmd = 'apt-get update && apt-get upgrade -y';
      if (osType.includes('rhel') || osType.includes('centos') || osType.includes('fedora')) {
        installCmd = 'yum update -y';
      }

      const r = await pool.executeCommand(srv.id, sshCfg, `(${installCmd} && echo "REBOOT_NEEDED") || echo "FAILED: $?"`);
      const needsReboot = r.stdout.includes('REBOOT_NEEDED');

      return NextResponse.json({
        data: {
          success: !r.stdout.includes('FAILED'),
          message: needsReboot ? 'Updates installed. System needs reboot.' : 'Updates installed'
        }
      });
    }

    return NextResponse.json({ error: { message: 'Invalid action' } }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: { message: String(error) } }, { status: 500 });
  }
}
