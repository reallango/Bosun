import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { normalizeMac, formatMac, sendMagicPacket, broadcastForIp, WOL_PORT } from '@/lib/network/wake-on-lan';
import net from 'net';

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

    // The MAC may be overridden per request (e.g. to target a secondary NIC)
    // without persisting it to the server record.
    const body = await request.json().catch(() => ({}));
    const macInput = (body?.mac_address || server.mac_address || '').toString();
    const mac = normalizeMac(macInput);
    if (!mac) {
      return NextResponse.json(
        { error: { message: 'No valid MAC address configured for this server' } },
        { status: 400 }
      );
    }

    // A user-supplied broadcast target wins; otherwise fall back to the
    // server's /24 broadcast address (a MAC must be on the host's subnet).
    let broadcast = (body?.broadcast || '').toString().trim();
    if (!broadcast) {
      broadcast = broadcastForIp(server.hostname) || '255.255.255.255';
    }
    if (!net.isIPv4(broadcast)) {
      return NextResponse.json({ error: { message: 'Invalid broadcast address' } }, { status: 400 });
    }

    try {
      const result = await sendMagicPacket(mac, broadcast, { port: WOL_PORT });
      await logAudit({
        userId: (auth as any).userId,
        serverId,
        action: AuditActions.SERVER_WAKE,
        status: 'success',
        details: JSON.stringify({ mac: formatMac(mac), broadcast: result.broadcast, port: result.port }),
      });
      return NextResponse.json({ data: { success: true, mac: formatMac(mac), broadcast: result.broadcast, port: result.port } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logAudit({
        userId: (auth as any).userId,
        serverId,
        action: AuditActions.SERVER_WAKE,
        status: 'failure',
        details: JSON.stringify({ mac: formatMac(mac), broadcast, error: message }),
      });
      return NextResponse.json({ error: { message: `Failed to send magic packet: ${message}` } }, { status: 502 });
    }
  } catch (error) {
    console.error('Wake-on-LAN error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
