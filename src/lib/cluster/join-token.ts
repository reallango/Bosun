/**
 * One-time join codes (version 2).
 *
 * A version 1 code carried the cluster's MASTER_KEY and AUTH_SECRET themselves, so anyone who ever saw one (a chat, a
 * ticket, a screenshot) held the cluster's secrets for good. A version 2 code carries only the members, the addresses
 * of the cluster's web app and a one-time token: an id and a random secret. The joining node exchanges the token at
 * a member (POST /api/setup/join-token) for the secrets:
 *
 *   - it sends the id and a proof (HMAC of the id with the token secret), never the secret itself;
 *   - the member checks the proof, deletes the token (it works once), and answers with the secrets encrypted
 *     (AES-256-GCM) under a key derived from the token secret.
 *
 * Someone watching the network sees the id, the proof and ciphertext only. A code that was used, or is older than
 * 24 hours, is worthless. Tokens are stored as app_config rows `cluster.join_token.<id>`, their secret encrypted with
 * the master key.
 */
import crypto from 'crypto';

export const JOIN_TOKEN_TTL_MS = 24 * 3600 * 1000;
export const JOIN_TOKEN_KEY_PREFIX = 'cluster.join_token.';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(String(s), 'base64url');

export function newToken(): { id: string; secret: string } {
  return { id: b64u(crypto.randomBytes(12)), secret: b64u(crypto.randomBytes(32)) };
}

export function isTokenId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16}$/.test(id);
}

/** What the joining node sends instead of the secret. */
export function tokenProof(id: string, secret: string): string {
  return crypto.createHmac('sha256', fromB64u(secret)).update(`bosun-join-proof:${id}`).digest('hex');
}

export function proofMatches(id: string, secret: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  const a = Buffer.from(tokenProof(id, secret), 'hex');
  const b = Buffer.from(proof, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exchangeKey(id: string, secret: string): Buffer {
  return crypto.createHmac('sha256', fromB64u(secret)).update(`bosun-join-key:${id}`).digest();
}

export interface SealedSecrets { iv: string; tag: string; ct: string }

/** Encrypt { mk, as } for the holder of the token secret. */
export function sealSecrets(id: string, secret: string, payload: { mk: string; as: string }): SealedSecrets {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', exchangeKey(id, secret), iv);
  c.setAAD(Buffer.from(id));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return { iv: b64u(iv), tag: b64u(c.getAuthTag()), ct: b64u(ct) };
}

export function openSecrets(id: string, secret: string, sealed: SealedSecrets): { mk: string; as: string } {
  const d = crypto.createDecipheriv('aes-256-gcm', exchangeKey(id, secret), fromB64u(sealed.iv));
  d.setAAD(Buffer.from(id));
  d.setAuthTag(fromB64u(sealed.tag));
  const out = JSON.parse(Buffer.concat([d.update(fromB64u(sealed.ct)), d.final()]).toString('utf8'));
  if (typeof out?.mk !== 'string' || typeof out?.as !== 'string' || !out.mk || !out.as) throw new Error('incomplete secrets');
  return out;
}

/** Web addresses a joining node may exchange the token at: http(s) origins only, deduplicated, at most 8. */
export function cleanWebOrigins(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const u = new URL(String(raw));
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password) {
        if (!out.includes(u.origin)) out.push(u.origin);
      }
    } catch { /* not a URL */ }
    if (out.length >= 8) break;
  }
  return out;
}
