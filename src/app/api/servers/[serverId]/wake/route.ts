import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { getConfig, setConfig } from '@/lib/db/migrations';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { normalizeMac, formatMac, sendMagicPacket, broadcastForIp, WOL_PORT } from '@/lib/network/wake-on-lan';
import {
  wakeViaLinuxHost,
  wakeViaWindowsHost,
  wolInstallPlanLinux,
  wolInstallPlanWindows,
  HostWakeOutcome,
} from '@/lib/network/host-wol';
import { sshPool, SSHConnectionConfig, CommandResult } from '@/lib/ssh/connection-pool';
import { decrypt } from '@/lib/crypto/keys';
import { isWindows, powershellCommand } from '@/lib/ssh/platform';
import net from 'net';

interface LocalServerCtx {
  server: any;
  run: (cmd: string) => Promise<CommandResult>;
  runPS: (script: string) => Promise<CommandResult>;
  platform: 'linux' | 'windows';
}

interface ResolveResult {
  ctx?: LocalServerCtx;
  error?: string;
  code?: string;
}

/**
 * Load the server configured as the WoL sender and build SSH runners for it.
 *
 * The wake command runs on this host (normally the Docker host) because the
 * magic packet must originate on the target's L2 segment. `wol.local_server_id`
 * is stored as an app_config key rather than a column so this stays out of the
 * server form.
 */
async function resolveLocalServer(): Promise<ResolveResult> {
  const id = await getConfig('wol.local_server_id');
  if (!id) {
    return {
      error: 'No local server is configured for Wake-on-LAN. Pick one under Settings > Wake-on-LAN.',
      code: 'WOL_NO_LOCAL_SERVER',
    };
  }
  const r = await rqlite.query('SELECT * FROM servers WHERE id = ?', [id]);
  if (!r.values?.length) {
    return { error: 'The Wake-on-LAN local server no longer exists.', code: 'WOL_LOCAL_SERVER_MISSING' };
  }
  const s = rowsToObjects(r)[0] as any;
  if (!s.ssh_key_id) {
    return { error: `Local server "${s.name}" has no SSH key configured.`, code: 'WOL_NO_SSH_KEY' };
  }
  const k = await rqlite.query('SELECT private_key_enc FROM ssh_keys WHERE id = ?', [s.ssh_key_id]);
  if (!k.values?.length) {
    return { error: 'SSH key for the local server was not found.', code: 'WOL_KEY_MISSING' };
  }
  let pk: string;
  try {
    pk = decrypt(k.values[0][0] as string, process.env.MASTER_KEY || '');
  } catch {
    return { error: 'Failed to decrypt the local server SSH key.', code: 'WOL_KEY_DECRYPT_FAILED' };
  }
  if (!pk) {
    return { error: 'Failed to decrypt the local server SSH key.', code: 'WOL_KEY_DECRYPT_FAILED' };
  }
  const cfg: SSHConnectionConfig = { host: s.hostname, port: s.ssh_port || 22, username: s.ssh_user, privateKey: pk };
  const run = (cmd: string) => sshPool.executeCommand(s.id, cfg, cmd);
  const runPS = (script: string) => sshPool.executeCommand(s.id, cfg, powershellCommand(script));
  return { ctx: { server: s, run, runPS, platform: isWindows(s) ? 'windows' : 'linux' } };
}

/**
 * Pick the broadcast address for a magic packet: the target's /24 broadcast when
 * the target is a numeric IPv4, else the limited broadcast.
 */
function targetBroadcast(targetHostname: string): string {
  return broadcastForIp(targetHostname) || '255.255.255.255';
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ serverId: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleError = requireRole(auth as any, 'operator');
  if (roleError) return roleError;
  const { serverId } = await params;

  try {
    const srv = await rqlite.query('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!srv.values?.length) return NextResponse.json({ error: { message: 'Server not found' } }, { status: 404 });
    const server = rowsToObjects(srv)[0] as any;

    const body = await request.json().catch(() => ({}));
    const action = (body?.action || 'wake').toString();
    const useLocal = (await getConfig('wol.use_local_server')) === 'true';

    if (action === 'install') {
      const { ctx, error, code } = await resolveLocalServer();
      if (error || !ctx) return NextResponse.json({ error: { message: error, code } }, { status: 409 });
      return await installWol(auth, ctx);
    }

    // The MAC may be overridden per request (e.g. to target a secondary NIC)
    // without persisting it to the server record.
    const macInput = (body?.mac_address || server.mac_address || '').toString();
    const mac = normalizeMac(macInput);
    if (!mac) {
      return NextResponse.json(
        { error: { message: 'No valid MAC address configured for this server' } },
        { status: 400 }
      );
    }

    const suppliedBroadcast = (body?.broadcast || '').toString().trim();
    if (suppliedBroadcast && !net.isIPv4(suppliedBroadcast)) {
      return NextResponse.json({ error: { message: 'Invalid broadcast address' } }, { status: 400 });
    }
    const broadcast = suppliedBroadcast || targetBroadcast(server.hostname);

    // The container path needs no local server, so resolve it only when the
    // packet is actually sent from a managed host.
    if (!useLocal) {
      return await wakeFromContainer(auth, serverId, server, mac, broadcast);
    }

    const { ctx, error, code } = await resolveLocalServer();
    if (error || !ctx) return NextResponse.json({ error: { message: error, code } }, { status: 409 });

    let outcome: HostWakeOutcome;
    try {
      outcome = ctx.platform === 'windows'
        ? await wakeViaWindowsHost(ctx.runPS, formatMac(mac)!, broadcast, WOL_PORT)
        : await wakeViaLinuxHost(ctx.run, formatMac(mac)!, broadcast, WOL_PORT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: auth.userId,
        serverId,
        action: AuditActions.SERVER_WAKE,
        status: 'failure',
        details: JSON.stringify({ via: 'local_server', host: ctx.server.hostname, error: message }),
      });
      return NextResponse.json(
        { error: { message: `Could not reach ${ctx.server.name} over SSH: ${message}`, code: 'WOL_HOST_UNREACHABLE' } },
        { status: 502 }
      );
    }

    if (outcome.ok) {
      // A successful send proves the utility is present; remember it so the UI
      // stops offering an install.
      if ((await getConfig('wol.remote_wol_installed')) !== 'true') {
        await setConfig('wol.remote_wol_installed', 'true');
      }
      await logAudit({
        userId: auth.userId,
        serverId,
        action: AuditActions.SERVER_WAKE,
        status: 'success',
        details: JSON.stringify({ via: 'local_server', host: ctx.server.hostname, mac: formatMac(mac), broadcast, port: WOL_PORT }),
      });
      return NextResponse.json({
        data: {
          success: true,
          via: 'local_server',
          host: ctx.server.name,
          mac: formatMac(mac),
          broadcast,
          port: WOL_PORT,
        },
      });
    }

    if (outcome.needsInstall) {
      await setConfig('wol.remote_wol_installed', 'false');
    }
    await logAudit({
      userId: auth.userId,
      serverId,
      action: AuditActions.SERVER_WAKE,
      status: 'failure',
      details: JSON.stringify({ via: 'local_server', mac: formatMac(mac), broadcast, error: outcome.error, needs_install: outcome.needsInstall }),
    });
    return NextResponse.json(
      {
        error: {
          message: outcome.needsInstall
            ? `wakeonlan is not installed on ${ctx.server.name}.`
            : `Failed to send magic packet from ${ctx.server.name}: ${outcome.error}`,
          code: outcome.needsInstall ? 'WOL_NOT_INSTALLED' : 'WOL_SEND_FAILED',
          needs_install: outcome.needsInstall,
          host: ctx.server.name,
        },
      },
      { status: 502 }
    );
  } catch (error) {
    console.error('Wake-on-LAN error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

/** Send the packet straight from the Bosun container (the original behaviour). */
async function wakeFromContainer(
  auth: any,
  serverId: string,
  server: any,
  mac: string,
  broadcast: string
) {
  try {
    const result = await sendMagicPacket(mac, broadcast, { port: WOL_PORT });
    await logAudit({
      userId: auth.userId,
      serverId,
      action: AuditActions.SERVER_WAKE,
      status: 'success',
      details: JSON.stringify({ via: 'container', mac: formatMac(mac), broadcast: result.broadcast, port: result.port }),
    });
    return NextResponse.json({
      data: { success: true, via: 'container', mac: formatMac(mac), broadcast: result.broadcast, port: result.port },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logAudit({
      userId: auth.userId,
      serverId,
      action: AuditActions.SERVER_WAKE,
      status: 'failure',
      details: JSON.stringify({ via: 'container', mac: formatMac(mac), broadcast, error: message }),
    });
    return NextResponse.json(
      { error: { message: `Failed to send magic packet: ${message}`, code: 'WOL_SEND_FAILED' } },
      { status: 502 }
    );
  }
}

/** Install the `wakeonlan` utility on the local server. */
async function installWol(auth: any, ctx: LocalServerCtx) {
  const plan = ctx.platform === 'windows' ? wolInstallPlanWindows() : wolInstallPlanLinux(ctx.server.os_type);
  if (!plan.supported || !plan.command) {
    return NextResponse.json(
      { error: { message: plan.note || 'Automatic installation is not supported on this host.', code: 'WOL_INSTALL_UNSUPPORTED' } },
      { status: 400 }
    );
  }

  try {
    // Prefer a passwordless install (root, or NOPASSWD sudo); otherwise sudo -n
    // fails fast with a clear message instead of hanging on a password prompt.
    const probe = await ctx.run('id -u');
    const asRoot = probe.stdout.trim() === '0';
    const command = asRoot ? plan.command : `sudo -n ${plan.command}`;
    const r = await ctx.run(command);
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout).trim() || `exit code ${r.exitCode}`;
      await logAudit({
        userId: auth.userId,
        action: AuditActions.SERVER_WOL_INSTALL,
        status: 'failure',
        details: JSON.stringify({ host: ctx.server.hostname, error: detail }),
      });
      return NextResponse.json(
        {
          error: {
            message: `Install failed on ${ctx.server.name}: ${detail}. You can also install wakeonlan manually on the host.`,
            code: 'WOL_INSTALL_FAILED',
          },
        },
        { status: 502 }
      );
    }

    const installed = ctx.platform === 'windows'
      ? false
      : (await ctx.run('command -v wakeonlan >/dev/null 2>&1 && echo INSTALLED || echo MISSING')).stdout.includes('INSTALLED');
    await setConfig('wol.remote_wol_installed', installed ? 'true' : 'false');
    await logAudit({
      userId: auth.userId,
      action: AuditActions.SERVER_WOL_INSTALL,
      status: installed ? 'success' : 'failure',
      details: JSON.stringify({ host: ctx.server.hostname, command: plan.command, installed }),
    });
    if (!installed) {
      return NextResponse.json(
        { error: { message: `Install command finished on ${ctx.server.name} but wakeonlan is still missing.`, code: 'WOL_INSTALL_FAILED' } },
        { status: 502 }
      );
    }
    return NextResponse.json({ data: { success: true, host: ctx.server.name, installed: true } });
  } catch (error) {
    console.error('Wake-on-LAN install error:', error);
    return NextResponse.json({ error: { message: String(error), code: 'WOL_INSTALL_FAILED' } }, { status: 502 });
  }
}
