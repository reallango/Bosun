/**
 * Lookups (spec version 2): a widget's external data, for example the newest release of the software it manages.
 *
 * A lookup is an HTTPS GET of a fixed URL, performed by the web process (never by a host script, never by the browser).
 * Only hosts the package's manifest lists under `network` are contacted, and everything that could turn this into a way
 * to reach Bosun's own network is refused: no redirects, no addresses of the loopback, private, link-local or reserved
 * ranges (checked on the address actually connected to, so a name that changes its answer does not help), a size limit
 * and a time limit. The value at `path` (optionally the one capture group of `match`) is the result.
 */
import https from 'https';
import dns from 'dns';
import net from 'net';
import type { LookupSpec } from '@/lib/widgets/runtime/spec-v2';

export const MAX_LOOKUP_BYTES = 256 * 1024;
export const LOOKUP_TIMEOUT_MS = 6000;
const FAILURE_TTL_MS = 30_000;

export class LookupError extends Error {}

/** True for every address a lookup must never connect to. */
export function isPrivateAddress(address: string): boolean {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && Number(address.split('.')[2]) === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;   // not an address at all
}

/** May `url` be fetched given the hosts the manifest lists? https only, default port, no credentials, host on the list. */
export function checkLookupUrl(url: string, hosts: readonly string[]): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new LookupError('the lookup URL is not valid'); }
  if (u.protocol !== 'https:') throw new LookupError('lookups use https only');
  if (u.username || u.password) throw new LookupError('lookup URLs carry no credentials');
  if (u.port) throw new LookupError('lookup URLs use the default port');
  const host = u.hostname.toLowerCase();
  if (net.isIP(host) || host.startsWith('[')) throw new LookupError('lookups name a host, not an address');
  if (!hosts.map(h => h.toLowerCase()).includes(host)) throw new LookupError(`the package does not declare network access to ${host}`);
  return u;
}

/** The value at a dotted path (array indexes allowed) of a parsed JSON answer, as text; null when it is not a scalar. */
export function valueAtPath(json: unknown, path: string): string | null {
  let cur: unknown = json;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return null;
      cur = cur[Number(part)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return null;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : null;
}

/** The one capture group of `match` applied to the value (null when it does not match). */
export function applyMatch(value: string, match: string | undefined): string | null {
  if (!match) return value;
  const m = new RegExp(match).exec(value);
  return m && m[1] !== undefined ? m[1] : null;
}

export interface Fetched { status: number; body: string }
export type Transport = (url: URL) => Promise<Fetched>;

/** A DNS lookup that refuses to answer with an address a lookup must not use. */
export const safeLookup = (hostname: string, options: dns.LookupOptions, callback: (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void): void => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some(a => isPrivateAddress(a.address))) return callback(new LookupError('the host resolves to an address that lookups may not use'));
    // Node asks for every address (all: true) when it connects to several families; otherwise it wants one.
    return options.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  });
};

/** The real transport: one https GET, no redirects, limits on time and size. */
export const httpsTransport: Transport = (url) => new Promise((resolve, reject) => {
  const req = https.request(url, { method: 'GET', lookup: safeLookup as unknown as net.LookupFunction, timeout: LOOKUP_TIMEOUT_MS, headers: { accept: 'application/json', 'user-agent': 'Bosun-lookup' } }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_LOOKUP_BYTES) { req.destroy(new LookupError('the answer is too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new LookupError('the lookup timed out')));
  req.on('error', reject);
  req.end();
});

/** Perform one lookup; the value, or null when the answer has no such value. Throws LookupError for a refused or failed request. */
export async function performLookup(spec: LookupSpec, hosts: readonly string[], transport: Transport = httpsTransport): Promise<string | null> {
  const url = checkLookupUrl(spec.url, hosts);
  let r: Fetched;
  try { r = await transport(url); } catch (err) {
    throw err instanceof LookupError ? err : new LookupError(`the lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (r.status >= 300 && r.status < 400) throw new LookupError('the host answered with a redirect (not followed)');
  if (r.status !== 200) throw new LookupError(`the host answered ${r.status}`);
  let json: unknown;
  try { json = JSON.parse(r.body); } catch { throw new LookupError('the answer is not JSON'); }
  const value = valueAtPath(json, spec.path);
  return value === null ? null : applyMatch(value, spec.match);
}

// ---- cached lookups for a package ----------------------------------------------------------------------------------

interface Entry { at: number; ttlMs: number; value: string | null; error?: string }
const g = globalThis as unknown as { __bosunLookups?: Map<string, Entry> };
const cache = g.__bosunLookups ?? (g.__bosunLookups = new Map());

/**
 * The values of all lookups of a spec (id -> value or null), each cached for its `ttlSec`; a failed lookup is remembered
 * for a short while so an unreachable host is not asked for on every request. A failure gives null, never an error.
 */
export async function loadLookups(
  packageId: string, lookups: Record<string, LookupSpec> | undefined, hosts: readonly string[], transport: Transport = httpsTransport, now = Date.now(),
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(Object.entries(lookups ?? {}).map(async ([id, spec]) => {
    const key = `${packageId}:${id}:${spec.url}:${spec.path}:${spec.match ?? ''}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < hit.ttlMs) { out[id] = hit.value; return; }
    try {
      const value = await performLookup(spec, hosts, transport);
      cache.set(key, { at: now, ttlMs: spec.ttlSec * 1000, value });
      out[id] = value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (hit?.error !== message) console.warn(`[widgets] lookup ${packageId}/${id}: ${message}`);
      cache.set(key, { at: now, ttlMs: FAILURE_TTL_MS, value: hit ? hit.value : null, error: message });
      out[id] = hit ? hit.value : null;
    }
  }));
  return out;
}

/** Forget cached lookups (tests, and after a package changes). */
export function clearLookupCache(): void { cache.clear(); }
