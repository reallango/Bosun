/**
 * The client's IP address, as far as it can be trusted.
 *
 * nginx (nginx/nginx.conf) always overwrites X-Bosun-Peer with the address of
 * whoever opened the connection, so a client cannot forge it. X-Forwarded-For
 * is client-controlled and is only read when that peer is a trusted proxy
 * (TRUSTED_PROXIES: comma-separated IPs or CIDRs, e.g. the cloudflared
 * container or a reverse proxy). Then the rightmost address that is not
 * itself a trusted proxy is the client.
 *
 * Shared by the web app (TypeScript) and ws-server.js (plain Node).
 */
'use strict';

const net = require('net');

/** Strip the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 -> 1.2.3.4). */
function normalize(ip) {
  const s = String(ip || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

function parseList(value) {
  const list = new net.BlockList();
  let count = 0;
  for (const raw of String(value || '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bits] = entry.split('/');
    const ip = normalize(addr);
    const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    if (!type) continue;
    try {
      if (bits !== undefined) list.addSubnet(ip, Number(bits), type);
      else list.addAddress(ip, type);
      count++;
    } catch { /* ignore a malformed entry */ }
  }
  return { list, count };
}

let cached = { raw: null, parsed: null };
function trusted() {
  const raw = process.env.TRUSTED_PROXIES || '';
  if (cached.raw !== raw) cached = { raw, parsed: parseList(raw) };
  return cached.parsed;
}

function isTrusted(ip, parsed = trusted()) {
  const v = normalize(ip);
  if (!parsed.count) return false;
  if (net.isIPv4(v)) return parsed.list.check(v, 'ipv4');
  if (net.isIPv6(v)) return parsed.list.check(v, 'ipv6');
  return false;
}

/**
 * @param {string|null|undefined} peer  the connecting address (X-Bosun-Peer, or the socket's remoteAddress)
 * @param {string|null|undefined} xff   the X-Forwarded-For header
 * @returns {string} the client address, or 'unknown'
 */
function resolveClientIp(peer, xff) {
  const parsed = trusted();
  let ip = normalize(peer);
  if (!ip) return 'unknown';
  if (!isTrusted(ip, parsed) || !xff) return ip;
  const hops = String(xff).split(',').map(normalize).filter(h => net.isIP(h));
  for (let i = hops.length - 1; i >= 0; i--) {
    ip = hops[i];
    if (!isTrusted(ip, parsed)) return ip;
  }
  return ip;
}

/** From a header getter: (name) => value. */
function clientIpFromHeaders(get, socketAddress) {
  const peer = get('x-bosun-peer') || socketAddress || '';
  return resolveClientIp(peer, get('x-forwarded-for'));
}

module.exports = { resolveClientIp, clientIpFromHeaders, isTrusted, normalize };
