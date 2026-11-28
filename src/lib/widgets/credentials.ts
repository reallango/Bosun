/**
 * The generic credential store of widget packages: entries of a credential kind (a Git token for one owner, a backup
 * destination for one host) that are created, edited and deleted on a package screen instead of Settings → Widgets.
 *
 * Secrets are encrypted with Bosun's master key and kept in their own column: no read path (API, MCP, screen data) ever
 * selects it. Only `resolveCredentialUses` decrypts one entry, on the server, and only to hand it to the script that
 * declared it — as BOSUN_CRED_<KIND>_<FIELD> environment variables, never as parameters.
 */
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { decrypt, encrypt } from '@/lib/crypto/keys';
import { getMasterKey } from '@/lib/secrets';
import { deletePackageSecret, getPackageSecrets } from '@/lib/widgets/package-secrets';
import { listInstalledPackages } from '@/lib/widgets/package-store';
import type { CredentialUse } from '@/lib/widgets/runtime/spec-v2';
import {
  credentialEnvName, defaultCredentialForServer, matchCredentialByUrl, planCredentialMigration,
  validateCredentialMeta, validateCredentialValues,
  type CredentialKindDef, type MatchableCredential,
} from '@/lib/widgets/credentials-schema';

export class CredentialError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 409, code = 'CREDENTIAL_MISSING') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface CredentialSecretStatus { set: boolean; hint: string | null }

/** What the browser (and MCP) may see of an entry: public fields, secret status and last use, never a secret. */
export interface CredentialPublic {
  id: string;
  packageId: string;
  kind: string;
  name: string;
  fields: Record<string, string>;
  servers: string[];
  isDefault: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  lastUsedAction: string | null;
  secrets: Record<string, CredentialSecretStatus>;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  package_id: string;
  kind: string;
  name: string;
  public_fields: string;
  servers: string;
  is_default: number | boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  last_used_at: string | null;
  last_used_by: string | null;
  last_used_action: string | null;
}

const parseObject = (raw: unknown): Record<string, string> => {
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch { return {}; }
};

const parseServers = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
};

const secretHint = (value: string): string | null => (value.length > 8 ? value.slice(-4) : null);

function decryptFields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const enc = parseObject(raw);
  for (const [id, cipher] of Object.entries(enc)) {
    if (!cipher) continue;
    try { out[id] = decrypt(cipher, getMasterKey()); } catch { /* unreadable: treated as not set */ }
  }
  return out;
}

async function secretColumn(id: string): Promise<string | null> {
  const r = await rqlite.query('SELECT secrets_enc FROM widget_credentials WHERE id = ?', [id]);
  const row = r.values?.[0];
  return row ? String(row[0] ?? '') : null;
}

async function toPublic(row: CredentialRow, kind: CredentialKindDef | null, secrets?: Record<string, string>): Promise<CredentialPublic> {
  const publicFields = parseObject(row.public_fields);
  const secretFields: Record<string, CredentialSecretStatus> = {};
  if (kind) {
    const values = secrets ?? decryptFields(await secretColumn(row.id));
    for (const f of kind.fields) {
      if (f.type !== 'secret') continue;
      const value = values[f.id];
      secretFields[f.id] = value ? { set: true, hint: secretHint(value) } : { set: false, hint: null };
    }
  }
  return {
    id: row.id, packageId: row.package_id, kind: row.kind, name: row.name,
    fields: publicFields,
    servers: parseServers(row.servers),
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at ?? ''), createdBy: row.created_by ? String(row.created_by) : null,
    updatedAt: String(row.updated_at ?? ''), updatedBy: row.updated_by ? String(row.updated_by) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    lastUsedBy: row.last_used_by ? String(row.last_used_by) : null,
    lastUsedAction: row.last_used_action ? String(row.last_used_action) : null,
    secrets: secretFields,
  };
}

const COLUMNS = 'id, package_id, kind, name, public_fields, servers, is_default, created_at, created_by, updated_at, updated_by, last_used_at, last_used_by, last_used_action';

/** Every entry of one kind, with the public fields only. `serverId` narrows to the entries that apply to that server. */
export async function listCredentialEntries(packageId: string, kind: CredentialKindDef, serverId?: string): Promise<CredentialPublic[]> {
  const r = await rqlite.query(`SELECT ${COLUMNS} FROM widget_credentials WHERE package_id = ? AND kind = ? ORDER BY name COLLATE NOCASE`, [packageId, kind.id]);
  const rows = rowsToObjects(r) as unknown as CredentialRow[];
  const out: CredentialPublic[] = [];
  for (const row of rows) {
    if (serverId) {
      const servers = parseServers(row.servers);
      if (servers.length && !servers.includes(serverId)) continue;
    }
    out.push(await toPublic(row, kind));
  }
  return out;
}

export async function getCredentialEntry(packageId: string, kind: CredentialKindDef, id: string): Promise<CredentialPublic | null> {
  const r = await rqlite.query(`SELECT ${COLUMNS} FROM widget_credentials WHERE id = ? AND package_id = ? AND kind = ?`, [id, packageId, kind.id]);
  const row = (rowsToObjects(r) as unknown as CredentialRow[])[0];
  return row ? toPublic(row, kind) : null;
}

export interface CredentialWriteInput {
  name?: unknown;
  fields?: unknown;
  secrets?: unknown;
  servers?: unknown;
  isDefault?: unknown;
}

export async function createCredential(packageId: string, kind: CredentialKindDef, input: CredentialWriteInput, userId: string | null): Promise<CredentialPublic> {
  const meta = validateCredentialMeta(kind, input.name, input.servers);
  if (!meta.ok) throw new CredentialError(meta.error, 400, 'INVALID_CREDENTIAL');
  const values = validateCredentialValues(kind, { fields: input.fields, secrets: input.secrets });
  if (!values.ok) throw new CredentialError(values.error, 400, 'INVALID_CREDENTIAL');
  const id = crypto.randomUUID();
  const isDefault = input.isDefault === true && kind.defaultPerServer;
  const enc = Object.fromEntries(Object.entries(values.value.secretFields).map(([k, v]) => [k, encrypt(v, getMasterKey())]));
  await rqlite.execute(
    `INSERT INTO widget_credentials (id, package_id, kind, name, public_fields, secrets_enc, servers, is_default, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
    [id, packageId, kind.id, meta.value.name, JSON.stringify(values.value.publicFields), JSON.stringify(enc), JSON.stringify(meta.value.servers), isDefault ? 1 : 0, userId, userId],
  );
  if (isDefault) await clearOtherDefaults(packageId, kind.id, meta.value.servers, id);
  return (await getCredentialEntry(packageId, kind, id))!;
}

export async function updateCredential(packageId: string, kind: CredentialKindDef, id: string, input: CredentialWriteInput, userId: string | null): Promise<CredentialPublic> {
  const existing = await getCredentialEntry(packageId, kind, id);
  if (!existing) throw new CredentialError('Credential not found', 404, 'NOT_FOUND');
  const meta = validateCredentialMeta(kind, input.name ?? existing.name, input.servers === undefined ? existing.servers : input.servers);
  if (!meta.ok) throw new CredentialError(meta.error, 400, 'INVALID_CREDENTIAL');
  const values = validateCredentialValues(kind, { fields: input.fields, secrets: input.secrets }, {
    partial: true,
    previousSecrets: new Set(Object.entries(existing.secrets).filter(([, s]) => s.set).map(([k]) => k)),
  });
  if (!values.ok) throw new CredentialError(values.error, 400, 'INVALID_CREDENTIAL');
  const publicFields = input.fields === undefined ? existing.fields : values.value.publicFields;
  // A secret left out (or given as an empty string) stays as it was; null clears it.
  const enc = parseObject((await rqlite.query('SELECT secrets_enc FROM widget_credentials WHERE id = ?', [id])).values?.[0]?.[0]);
  for (const [field, value] of Object.entries(values.value.secretFields)) {
    if (value === '') delete enc[field];
    else enc[field] = encrypt(value, getMasterKey());
  }
  const isDefault = input.isDefault === undefined ? existing.isDefault : input.isDefault === true && kind.defaultPerServer;
  await rqlite.execute(
    `UPDATE widget_credentials SET name = ?, public_fields = ?, secrets_enc = ?, servers = ?, is_default = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [meta.value.name, JSON.stringify(publicFields), JSON.stringify(enc), JSON.stringify(meta.value.servers), isDefault ? 1 : 0, userId, id],
  );
  if (isDefault) await clearOtherDefaults(packageId, kind.id, meta.value.servers, id);
  return (await getCredentialEntry(packageId, kind, id))!;
}

export async function deleteCredential(packageId: string, id: string): Promise<boolean> {
  const r = await rqlite.execute('DELETE FROM widget_credentials WHERE id = ? AND package_id = ?', [id, packageId]);
  return r.rows_affected > 0;
}

/** Remove every credential of a package (when the package itself is removed). */
export async function deletePackageCredentials(packageId: string): Promise<void> {
  await rqlite.execute('DELETE FROM widget_credentials WHERE package_id = ?', [packageId]);
}

/** Clear the default flag of the entries of this kind whose server scope overlaps the new default. */
async function clearOtherDefaults(packageId: string, kindId: string, servers: string[], exceptId: string): Promise<void> {
  const r = await rqlite.query('SELECT id, servers FROM widget_credentials WHERE package_id = ? AND kind = ? AND is_default = 1 AND id != ?', [packageId, kindId, exceptId]);
  for (const [id, raw] of r.values ?? []) {
    const other = parseServers(raw);
    const overlap = !servers.length || !other.length || other.some(s => servers.includes(s));
    if (overlap) await rqlite.execute('UPDATE widget_credentials SET is_default = 0 WHERE id = ?', [String(id)]);
  }
}

interface Candidate extends MatchableCredential { servers: string[] }

async function candidatesFor(packageId: string, kind: CredentialKindDef, serverId: string): Promise<Candidate[]> {
  const r = await rqlite.query(`SELECT id, name, public_fields, servers, is_default, updated_at FROM widget_credentials WHERE package_id = ? AND kind = ?`, [packageId, kind.id]);
  const out: Candidate[] = [];
  for (const row of rowsToObjects(r)) {
    const servers = parseServers(row.servers);
    if (servers.length && !servers.includes(serverId)) continue;
    out.push({
      id: String(row.id), name: String(row.name), fields: parseObject(row.public_fields),
      servers, isDefault: Number(row.is_default) === 1, updatedAt: String(row.updated_at ?? ''),
    });
  }
  return out;
}

async function markUsed(id: string, usedBy: string): Promise<void> {
  await rqlite.execute(
    'UPDATE widget_credentials SET last_used_at = CURRENT_TIMESTAMP, last_used_action = ? WHERE id = ?',
    [usedBy.slice(0, 80), id],
  ).catch(() => undefined);
}

export interface ResolvedCredentials {
  /** The BOSUN_CRED_* variables handed to the script. */
  env: Record<string, string>;
  /** The secret values (never public fields), so the runner can keep them out of logs. */
  secrets: string[];
}

/**
 * Resolve the credentials a script declared and turn the chosen entry into its BOSUN_CRED_* environment. `values` are
 * the script's validated arguments (a pinned entry id, a repository URL). Throws CredentialError when a required
 * credential has no entry; a URL match without an entry is left out (public repositories work without one).
 */
export async function resolveCredentialUses(
  packageId: string,
  kinds: CredentialKindDef[],
  uses: CredentialUse[] | undefined,
  values: Record<string, unknown>,
  serverId: string,
  usedBy: string,
): Promise<ResolvedCredentials> {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  if (!uses?.length) return { env, secrets };
  for (const use of uses) {
    const kind = kinds.find(k => k.id === use.kind);
    if (!kind) throw new CredentialError(`This package declares no credential kind "${use.kind}"`, 500, 'CREDENTIAL_KIND');
    const candidates = await candidatesFor(packageId, kind, serverId);
    const pinnedId = use.entry ? String(values[use.entry] ?? '').trim() : '';
    let chosen: Candidate | null = null;
    if (pinnedId && pinnedId !== 'auto') {
      chosen = candidates.find(c => c.id === pinnedId) ?? null;
      if (!chosen) throw new CredentialError(`The chosen ${kind.label.toLowerCase()} is not available on this server`);
    } else if (use.url) {
      const url = String(values[use.url] ?? '').trim();
      // "-" is the "not a Git source" value of a deploy form; there is nothing to match then.
      if (url && url !== '-') chosen = matchCredentialByUrl(candidates, url) as Candidate | null;
    } else if (use.default) {
      chosen = defaultCredentialForServer(candidates, serverId) as Candidate | null;
    }
    const required = use.required ?? (use.default === true && !use.url);
    if (!chosen) {
      if (!required) continue;
      const url = use.url ? String(values[use.url] ?? '').trim() : '';
      throw new CredentialError(url
        ? `No ${kind.label.toLowerCase()} matches ${url}`
        : `No ${kind.label.toLowerCase()} is set for this server`);
    }
    const secretValues = decryptFields(await secretColumn(chosen.id));
    // The entry's id, so a listing can say which entry a snapshot belongs to and a restore can pick the same one.
    env[credentialEnvName(kind.id, 'id')] = chosen.id;
    for (const field of kind.fields) {
      const value = field.type === 'secret' ? secretValues[field.id] : chosen.fields[field.id];
      if (!value) continue;
      env[credentialEnvName(kind.id, field.id)] = value;
      if (field.type === 'secret') secrets.push(value);
    }
    await markUsed(chosen.id, usedBy);
  }
  return { env, secrets };
}

/** Which servers have a widget of this package (for the per-server default of a migrated entry). */
async function serversWithPackageWidgets(packageId: string): Promise<string[]> {
  const r = await rqlite.query(
    `SELECT DISTINCT w.server_id FROM widgets w JOIN custom_widgets c ON c.type = w.widget_type WHERE c.package_id = ?`,
    [packageId],
  );
  return (r.values ?? []).map(row => String(row[0]));
}

/**
 * Turn the legacy package secrets a manifest names under `migrate` into credential entries, then delete them. Runs at
 * startup, idempotent (deterministic ids, and the secrets are gone afterwards) and logs names only, never values.
 */
export async function migratePackageCredentials(): Promise<void> {
  let packages;
  try { packages = await listInstalledPackages(); } catch { return; }
  for (const pkg of packages) {
    const kinds = pkg.manifest.credentials;
    if (!kinds.length) continue;
    const secretIds = Array.from(new Set(kinds.flatMap(k => k.migrate.flatMap(r => [
      ...Object.values(r.fields ?? {}).filter(v => v.startsWith('secret:')).map(v => v.slice(7)),
      ...(r.hostList ? [r.hostList.secret] : []),
    ]))));
    if (!secretIds.length) continue;
    const legacy = await getPackageSecrets(pkg.id, secretIds);
    if (!Object.keys(legacy).length) continue;
    const packageServers = await serversWithPackageWidgets(pkg.id);
    const created: string[] = [];
    const consumed = new Set<string>();
    for (const kind of kinds) {
      const mine = Array.from(new Set(kind.migrate.flatMap(r => [
        ...Object.values(r.fields ?? {}).filter(v => v.startsWith('secret:')).map(v => v.slice(7)),
        ...(r.hostList ? [r.hostList.secret] : []),
      ]))).filter(sid => legacy[sid] !== undefined);
      const made: string[] = [];
      for (const plan of planCredentialMigration(kind, legacy, packageServers)) {
        const enc = Object.fromEntries(Object.entries(plan.secretFields).map(([k, v]) => [k, encrypt(v, getMasterKey())]));
        const r = await rqlite.execute(
          `INSERT OR IGNORE INTO widget_credentials (id, package_id, kind, name, public_fields, secrets_enc, servers, is_default, created_by, created_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)`,
          [plan.id, pkg.id, kind.id, plan.name, JSON.stringify(plan.publicFields), JSON.stringify(enc), JSON.stringify(plan.servers), plan.isDefault ? 1 : 0],
        );
        if (r.rows_affected > 0) made.push(plan.name);
      }
      // Only drop a kind's legacy secrets once they actually became entries: an incomplete destination stays editable.
      if (made.length) { mine.forEach(sid => consumed.add(sid)); created.push(...made); }
    }
    for (const sid of Array.from(consumed)) await deletePackageSecret(pkg.id, sid);
    if (created.length) console.log(`[widgets] migrated package secrets of ${pkg.id} into credentials: ${created.join(', ')}`);
  }
}
