import dgram from 'dgram';
import net from 'net';

export const WOL_PORT = 9;

/**
 * Normalize a MAC address to the 12-hex-digit form used in a magic packet.
 * Accepts colon-, hyphen- or dot-separated (and bare) input. Returns null when
 * the value is not a valid 48-bit MAC.
 */
export function normalizeMac(mac: string): string | null {
  const hex = mac.trim().replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  return hex;
}

/** Human-readable colon form, or null for invalid input. */
export function formatMac(mac: string): string | null {
  const hex = normalizeMac(mac);
  if (!hex) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/**
 * Build a Wake-on-LAN magic packet: 6 sync bytes (0xFF) followed by the target
 * MAC repeated 16 times.
 */
export function buildMagicPacket(mac: string): Buffer {
  const hex = normalizeMac(mac);
  if (!hex) throw new Error('Invalid MAC address');
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

export interface WakeResult {
  broadcast: string;
  port: number;
  packetBytes: number;
}

/**
 * Send a WoL magic packet for `mac` to `broadcast` on the standard WoL port.
 *
 * The packet is sent to the subnet broadcast address because the target host is
 * powered off and has no ARP entry. The socket is bound to `bindAddress` (the
 * sending host's own address on that subnet) so the kernel selects the matching
 * interface; without a bind the OS may route a limited broadcast out of the
 * wrong NIC.
 */
export async function sendMagicPacket(
  mac: string,
  broadcast: string,
  options: { port?: number; bindAddress?: string } = {}
): Promise<WakeResult> {
  const packet = buildMagicPacket(mac);
  const port = options.port ?? WOL_PORT;

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    // The socket must be bound before setBroadcast/send; bind to the given
    // source address or to all interfaces, then broadcast.
    socket.bind(0, options.bindAddress || '0.0.0.0', () => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });

  return { broadcast, port, packetBytes: packet.length };
}

/** Derive the /24 broadcast address for an IPv4 address (e.g. 10.0.0.5 -> 10.0.0.255). */
export function broadcastForIp(ip: string): string | null {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
  }
  return null;
}
