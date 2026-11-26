/**
 * The client's IP address, as far as it can be trusted.
 *
 * nginx (nginx/nginx.conf) always overwrites X-Bosun-Peer with the address of
 * whoever opened the connection, so a client cannot forge it. X-Forwarded-For
 * is client-controlled and is only read when that peer is a trusted proxy
 * (TRUSTED_PROXIES: comma-separated IPs, CIDRs or host names, e.g. the
 * cloudflared container's name or a reverse proxy). Then the rightmost address
 * that is not itself a trusted proxy is the client.
 *
 * Host names (e.g. `cloudflared`, resolved by Docker's DNS on a shared network)
 * are looked up in the background when this module loads and again every
 * minute, so a container that gets a new address when it is recreated stays
 * trusted. Until a name has resolved it trusts nothing; a lookup that fails
 * for a moment keeps the addresses found last time.
 *
 * Shared by the web app (TypeScript) and ws-server.js (plain Node).
 */
'use strict';

const net = require('net');
const dns = require('dns');

const REFRESH_MS = Number(process.env.TRUSTED_PROXIES_REFRESH_MS) || 60_000;
/** A DNS name: letters, digits, dots and dashes, not starting or ending with a dot or dash. */
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Strip the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 -> 1.2.3.4). */
function normalize(ip) {
  const s = String(ip || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Split TRUSTED_PROXIES into address/CIDR entries and host names; anything else is ignored. */
function splitEntries(value) {
  const addresses = [];
  const names = [];
  for (const raw of String(value || '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bits] = entry.split('/');
    if (net.isIP(normalize(addr))) addresses.push(entry);
    else if (bits === undefined && HOST_RE.test(entry) && !/^\d+(\.\d+)*$/.test(entry)) names.push(entry.toLowerCase());
  }
  return { addresses, names };
}

function buildList(entries) {
  const list = new net.BlockList();
  let count = 0;
  for (const entry of entries) {
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

// ---- host names: resolved in the background ------------------------------------------------------------------
const g = globalThis;
const state = g.__bosunTrustedProxyNames || (g.__bosunTrustedProxyNames = { resolved: new Map(), timer: null, raw: null, lookup: null });

function lookupAll(name) {
  const lookup = state.lookup || dns.promises.lookup;
  return lookup(name, { all: true, verbatim: true }).then(rows => rows.map(r => normalize(r.address)).filter(a => net.isIP(a)));
}

function setResolved(name, addrs) {
  const first = !state.resolved.has(name);
  const before = (state.resolved.get(name) || []).join(', ');
  state.resolved.set(name, addrs);
  const after = addrs.join(', ');
  if (first || before !== after) {
    console.log(`[trusted-proxies] ${name} -> ${after || 'not found (not trusted)'}`);
  }
}

/** Look up every configured name once. Returns when done; never throws. */
async function refreshNames() {
  const { names } = splitEntries(process.env.TRUSTED_PROXIES);
  for (const known of Array.from(state.resolved.keys())) if (!names.includes(known)) state.resolved.delete(known);
  await Promise.all(names.map(async (name) => {
    try {
      const addrs = await lookupAll(name);
      if (addrs.length) setResolved(name, addrs);
      else if (!state.resolved.has(name)) setResolved(name, []);
    } catch (err) {
      // A name that does not exist (any more) trusts nothing; a passing DNS hiccup keeps what was found last time.
      if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) setResolved(name, []);
    }
  }));
  cached = { key: null, parsed: null };
}

function ensureRefreshing() {
  const raw = process.env.TRUSTED_PROXIES || '';
  if (state.raw === raw) return;
  state.raw = raw;
  const { names } = splitEntries(raw);
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (!names.length) { state.resolved.clear(); return; }
  refreshNames();
  state.timer = setInterval(refreshNames, REFRESH_MS);
  if (state.timer.unref) state.timer.unref();
}

// ---- the trusted list -------------------------------------------------------------------------------------------
let cached = { key: null, parsed: null };
function trusted() {
  ensureRefreshing();
  const { addresses, names } = splitEntries(process.env.TRUSTED_PROXIES);
  const fromNames = names.flatMap(n => state.resolved.get(n) || []);
  const key = addresses.join(',') + '|' + fromNames.join(',');
  if (cached.key !== key) cached = { key, parsed: buildList([...addresses, ...fromNames]) };
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

/** For tests and diagnostics: what each configured name resolved to. */
function resolvedNames() {
  return Object.fromEntries(state.resolved);
}

/** For tests: replace the DNS lookup and start over. */
function _setLookupForTests(fn) {
  state.lookup = fn;
  state.raw = null;
  state.resolved.clear();
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  cached = { key: null, parsed: null };
}

module.exports = { resolveClientIp, clientIpFromHeaders, isTrusted, normalize, splitEntries, refreshNames, resolvedNames, _setLookupForTests };
