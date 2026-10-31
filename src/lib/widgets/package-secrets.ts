/**
 * Secrets of widget packages (a GitHub token, an API key): declared by the package manifest, set by an admin, stored
 * encrypted with Bosun's master key in app_config, and handed only to the scripts that name them (as the environment
 * variable `BOSUN_SECRET_<id>`, never as a parameter, so they do not appear in the audit log or in the parameter list).
 * They are never sent to the browser and not exported with the package.
 */
import { rqlite } from '@/lib/db/rqlite-client';
import { decrypt, encrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';

const key = (packageId: string, id: string) => `pkgsecret.${packageId}.${id}`;
export const SECRET_ID_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const MAX_SECRET_LENGTH = 2000;

export async function setPackageSecret(packageId: string, id: string, value: string): Promise<void> {
  if (!SECRET_ID_RE.test(id)) throw new Error('invalid secret id');
  if (value.length === 0 || value.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`A secret is 1-${MAX_SECRET_LENGTH} characters on one line`);
  await rqlite.execute(
    `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key(packageId, id), encrypt(value, getMasterKey()), `Secret ${id} of the widget package ${packageId} (encrypted)`]);
}

export async function deletePackageSecret(packageId: string, id: string): Promise<void> {
  await rqlite.execute('DELETE FROM app_config WHERE key = ?', [key(packageId, id)]);
}

export async function deleteAllPackageSecrets(packageId: string): Promise<void> {
  await rqlite.execute('DELETE FROM app_config WHERE key LIKE ?', [`pkgsecret.${packageId}.%`]);
}

/** Which of the given secrets are set (true/false), without reading their values. */
export async function packageSecretStatus(packageId: string, ids: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = Object.fromEntries(ids.map(i => [i, false]));
  if (!ids.length) return out;
  const r = await rqlite.query(`SELECT key FROM app_config WHERE key IN (${ids.map(() => '?').join(',')}) AND value IS NOT NULL AND value != ''`, ids.map(i => key(packageId, i)));
  for (const row of r.values ?? []) out[String(row[0]).slice(key(packageId, '').length)] = true;
  return out;
}

/** The values of the named secrets that are set (missing ones are left out). Server side only, for running a script. */
export async function getPackageSecrets(packageId: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  const r = await rqlite.query(`SELECT key, value FROM app_config WHERE key IN (${ids.map(() => '?').join(',')})`, ids.map(i => key(packageId, i)));
  for (const row of r.values ?? []) {
    try { out[String(row[0]).slice(key(packageId, '').length)] = decrypt(String(row[1]), getMasterKey()); } catch { /* unreadable: treated as not set */ }
  }
  return out;
}
