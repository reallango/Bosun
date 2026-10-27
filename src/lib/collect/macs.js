'use strict';

/**
 * Pick the Wake-on-LAN MAC addresses of a host from its network interfaces.
 *
 * - primary: the physical NIC carrying the address Bosun's SSH connection
 *   arrived on (SSH_CONNECTION's server IP), i.e. the NIC the host is reached
 *   through; else the first physical NIC that is up with an IPv4 address.
 * - alt: for machines that move between wired and wireless, the physical NIC
 *   of the other kind (wired <-> wireless); else another physical NIC.
 *
 * Interfaces: [{ name, mac, physical, wireless, up, ipv4: [] }]
 */

const ZERO_MAC = /^(00[:-]?){5}00$/i;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

function normalize(mac) {
  return String(mac || '').trim().toLowerCase().replace(/-/g, ':');
}

/** Server IP from an SSH_CONNECTION value ("client_ip client_port server_ip server_port"). */
function serverIpFromSshConnection(value) {
  const parts = String(value || '').trim().split(/\s+/);
  return parts.length >= 4 ? parts[2].replace(/^::ffff:/, '') : null;
}

function usable(i) {
  const mac = normalize(i.mac);
  return i.physical && MAC_RE.test(mac) && !ZERO_MAC.test(mac);
}

function pickMacs(interfaces, serverIp) {
  const nics = (interfaces || []).filter(usable).map(i => ({ ...i, mac: normalize(i.mac) }));
  const byIp = serverIp ? nics.find(i => (i.ipv4 || []).includes(serverIp)) : null;
  const primary = byIp
    || nics.find(i => i.up && (i.ipv4 || []).length && !i.wireless)
    || nics.find(i => i.up && (i.ipv4 || []).length)
    || nics.find(i => !i.wireless)
    || nics[0]
    || null;
  let alt = null;
  if (primary) {
    const others = nics.filter(i => i.mac !== primary.mac);
    alt = others.find(i => !!i.wireless !== !!primary.wireless) || others[0] || null;
  }
  return {
    serverIp: serverIp || null,
    primary: primary ? { name: primary.name, mac: primary.mac, wireless: !!primary.wireless } : null,
    alt: alt ? { name: alt.name, mac: alt.mac, wireless: !!alt.wireless } : null,
    candidates: nics.map(i => ({ name: i.name, mac: i.mac, wireless: !!i.wireless, up: !!i.up, ipv4: i.ipv4 || [] })),
  };
}

module.exports = { pickMacs, serverIpFromSshConnection, normalize };
