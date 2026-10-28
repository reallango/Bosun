import { NextRequest, NextResponse } from 'next/server';
import net from 'net';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { setConfig } from '@/lib/db/migrations';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { normalizeMac, formatMac, sendMagicPacket, broadcastForIp, WOL_PORT } from '@/lib/network/wake-on-lan';
import { wakeViaLinuxHost, wakeViaWindowsHost, wolInstallPlanLinux, wolInstallPlanWindows, HostWakeOutcome } from '@/lib/network/host-wol';
import { resolveWolSender } from '@/lib/network/node-host';
import { sshPool, loadServerTarget, CommandResult } from '@/lib/ssh/connection-pool';
import { powershellCommand } from '@/lib/ssh/platform';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Status for "the wake could not be carried out" (sender unreachable, wakeonlan
 * missing, send failed). Not 502: Cloudflare replaces an origin 502/504 with
 * its own HTML error page, so the JSON error never reaches the browser when
 * Bosun is served through a tunnel.
 */
const WAKE_FAILED = 424;

interface SenderCtx {
  server: { id: string; name: string; hostname: string; os_type: string | null };
  platform: 'linux' | 'windows';
  run: (cmd: string) => Promise<CommandResult>;
  runPS: (script: string) => Promise<CommandResult>;
}

/** SSH runners for the server that sends the packets. */
async function senderContext(serverId: string): Promise<SenderCtx> {
  const r = await rqlite.query('SELECT id, name, hostname, os_type FROM servers WHERE id = ?', [serverId]);
  const s = rowsToObjects(r)[0] as any;
  if (!s) throw Object.assign(new Error('The Wake-on-LAN sending server no longer exists'), { code: 'WOL_SENDER_MISSING' });
  const t = await loadServerTarget(serverId);
  return {
    server: s,
    platform: t.platform,
    run: (cmd: string) => sshPool.executeCommand(t.id, t.config, cmd, { timeoutMs: 120_000 }),
    runPS: (script: string) => sshPool.executeCommand(t.id, t.config, powershellCommand(script), { timeoutMs: 120_000 }),
  };
}

/**
 * MACs to wake: an explicit override, else the stored primary and alternate
 * plus whatever the host last reported (in case a NIC was swapped). Sending a
 * magic packet to a MAC that is not there is harmless.
 */
async function macsFor(server: any, override: unknown): Promise<string[]> {
  if (override) {
    const m = normalizeMac(String(override));
    return m ? [m] : [];
  }
  const list = [server.mac_address, server.mac_address_alt];
  try {
    const r = await rqlite.query("SELECT data FROM host_snapshots WHERE server_id = ? AND section = 'nics'", [server.id]);
    const nics = r.values?.length ? JSON.parse(String(r.values[0][0])) : null;
    if (nics?.primary?.mac) list.push(nics.primary.mac);
    if (nics?.alt?.mac) list.push(nics.alt.mac);
  } catch { /* no snapshot yet */ }
  return Array.from(new Set(list.map(m => (m ? normalizeMac(String(m)) : null)).filter((m): m is string => !!m)));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth, 'operator');
  if (roleError) return roleError;
  const { serverId } = await params;

  try {
    const srv = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const server = rowsToObjects(srv)[0] as any;
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || 'wake');

    const limit = consumeActionRateLimit(auth.userId);
    if (!limit.allowed) return NextResponse.json({ error: { message: 'Too many actions, slow down', code: 'RATE_LIMITED' } }, { status: 429 });

    const sender = await resolveWolSender();

    if (action === 'install') {
      // Installing a package with sudo on a host is an admin action.
      const adminError = requireRole(auth, 'admin');
      if (adminError) return adminError;
      if (!sender.serverId) {
        return NextResponse.json({ error: { message: 'Packets are sent from the Bosun container; there is no host to install wakeonlan on.', code: 'WOL_NO_SENDER' } }, { status: 409 });
      }
      return await installWol(auth, await senderContext(sender.serverId));
    }

    const macs = await macsFor(server, body?.mac_address);
    if (!macs.length) {
      return NextResponse.json({ error: { message: 'No valid MAC address known for this server (set one, or wait for the next poll to detect it)' } }, { status: 400 });
    }
    const suppliedBroadcast = String(body?.broadcast || '').trim();
    if (suppliedBroadcast && !net.isIPv4(suppliedBroadcast)) {
      return NextResponse.json({ error: { message: 'Invalid broadcast address' } }, { status: 400 });
    }
    const broadcast = suppliedBroadcast || broadcastForIp(server.hostname) || '255.255.255.255';
    const formatted = macs.map(m => formatMac(m) as string);

    if (!sender.serverId) {
      if (sender.mode === 'local_server') {
        return NextResponse.json({ error: { message: 'No local server is configured for Wake-on-LAN. Pick one under Settings > Wake-on-LAN.', code: 'WOL_NO_LOCAL_SERVER' } }, { status: 409 });
      }
      return await wakeFromContainer(auth, serverId, formatted, broadcast, sender.mode === 'auto' ? 'host of this node not known' : undefined);
    }

    let ctx: SenderCtx;
    const outcomes: HostWakeOutcome[] = [];
    try {
      ctx = await senderContext(sender.serverId);
      for (const mac of formatted) {
        outcomes.push(ctx.platform === 'windows'
          ? await wakeViaWindowsHost(ctx.runPS, mac, broadcast, WOL_PORT)
          : await wakeViaLinuxHost(ctx.run, mac, broadcast, WOL_PORT));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // In auto mode the host is the one this node runs on; if SSH to it fails
      // anyway, the container is the next best sender.
      if (sender.mode === 'auto') return await wakeFromContainer(auth, serverId, formatted, broadcast, `host unreachable: ${message}`);
      await logAudit({ userId: auth.userId, serverId, action: AuditActions.SERVER_WAKE, status: 'failure',
        details: JSON.stringify({ via: 'local_server', sender: sender.serverId, error: message }) });
      return NextResponse.json({ error: { message: `Could not reach the sending server over SSH: ${message}`, code: 'WOL_HOST_UNREACHABLE' } }, { status: WAKE_FAILED });
    }

    const sent = formatted.filter((_, i) => outcomes[i].ok);
    const needsInstall = outcomes.some(o => o.needsInstall);
    await setConfig(`wol.installed.${ctx.server.id}`, needsInstall ? 'false' : 'true');
    await logAudit({
      userId: auth.userId, serverId, action: AuditActions.SERVER_WAKE, status: sent.length ? 'success' : 'failure',
      details: JSON.stringify({ via: 'host', sender: ctx.server.name, source: sender.source, macs: formatted, sent, broadcast }),
    });
    if (sent.length) {
      return NextResponse.json({ data: { success: true, via: 'local_server', host: ctx.server.name, source: sender.source, mac: sent.join(', '), macs: sent, broadcast, port: WOL_PORT } });
    }
    return NextResponse.json({
      error: {
        message: needsInstall
          ? `wakeonlan is not installed on ${ctx.server.name}.`
          : `Failed to send magic packet from ${ctx.server.name}: ${outcomes[0]?.error || 'unknown error'}`,
        code: needsInstall ? 'WOL_NOT_INSTALLED' : 'WOL_SEND_FAILED',
        needs_install: needsInstall,
        host: ctx.server.name,
      },
    }, { status: WAKE_FAILED });
  } catch (error) {
    console.error('Wake-on-LAN error:', error);
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

/** Send the packets straight from the Bosun container. */
async function wakeFromContainer(auth: any, serverId: string, macs: string[], broadcast: string, note?: string) {
  const sent: string[] = [];
  let lastError = '';
  for (const mac of macs) {
    try {
      await sendMagicPacket(mac, broadcast, { port: WOL_PORT });
      sent.push(mac);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  await logAudit({ userId: auth.userId, serverId, action: AuditActions.SERVER_WAKE, status: sent.length ? 'success' : 'failure',
    details: JSON.stringify({ via: 'container', macs, sent, broadcast, note, error: lastError || undefined }) });
  if (!sent.length) {
    return NextResponse.json({ error: { message: `Failed to send magic packet: ${lastError}`, code: 'WOL_SEND_FAILED' } }, { status: WAKE_FAILED });
  }
  return NextResponse.json({ data: { success: true, via: 'container', note, mac: sent.join(', '), macs: sent, broadcast, port: WOL_PORT } });
}

/** Install the `wakeonlan` utility on the sending server. */
async function installWol(auth: any, ctx: SenderCtx) {
  const plan = ctx.platform === 'windows' ? wolInstallPlanWindows() : wolInstallPlanLinux(ctx.server.os_type);
  if (!plan.supported || !plan.command) {
    return NextResponse.json({ error: { message: plan.note || 'Automatic installation is not supported on this host.', code: 'WOL_INSTALL_UNSUPPORTED' } }, { status: 400 });
  }
  // Root installs directly; otherwise non-interactive sudo fails fast instead of hanging.
  const asRoot = (await ctx.run('id -u')).stdout.trim() === '0';
  const r = await ctx.run(asRoot ? plan.command : `sudo -n ${plan.command}`);
  if (r.exitCode !== 0) {
    const detail = (r.stderr || r.stdout).trim() || `exit code ${r.exitCode}`;
    await logAudit({ userId: auth.userId, action: AuditActions.SERVER_WOL_INSTALL, status: 'failure', details: JSON.stringify({ host: ctx.server.hostname, error: detail }) });
    return NextResponse.json({ error: { message: `Install failed on ${ctx.server.name}: ${detail}. You can also install wakeonlan manually on the host.`, code: 'WOL_INSTALL_FAILED' } }, { status: WAKE_FAILED });
  }
  const installed = (await ctx.run('command -v wakeonlan >/dev/null 2>&1 && echo INSTALLED || echo MISSING')).stdout.includes('INSTALLED');
  await setConfig(`wol.installed.${ctx.server.id}`, installed ? 'true' : 'false');
  await logAudit({ userId: auth.userId, action: AuditActions.SERVER_WOL_INSTALL, status: installed ? 'success' : 'failure',
    details: JSON.stringify({ host: ctx.server.hostname, command: plan.command, installed }) });
  if (!installed) {
    return NextResponse.json({ error: { message: `Install finished on ${ctx.server.name} but wakeonlan is still missing.`, code: 'WOL_INSTALL_FAILED' } }, { status: WAKE_FAILED });
  }
  return NextResponse.json({ data: { success: true, host: ctx.server.name, installed: true } });
}
