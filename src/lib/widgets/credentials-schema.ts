/**
 * Credential kinds of a widget package: the parts of a package that hold values per server or per repository (a Git
 * token for one owner, a backup destination for one host) rather than one value for the whole cluster.
 *
 * A package declares the kinds in its manifest (`credentials`), each with public fields (shown in the UI) and secret
 * fields (write-only). This file is pure (no I/O) so the manifest validator, the routes and the tests share it.
 */
import { fail, ID_RE, isObj, text, type Validated } from './runtime/spec-util';

export const MAX_CREDENTIAL_KINDS = 8;
export const MAX_CREDENTIAL_FIELDS = 12;
export const MAX_CREDENTIAL_MIGRATIONS = 6;
export const MAX_CREDENTIAL_VALUE = 2000;
export const MAX_CREDENTIAL_NAME = 80;

export type CredentialFieldType = 'string' | 'secret';

export interface CredentialFieldDef {
  id: string;
  label: string;
  type: CredentialFieldType;
  /** Public fields are shown in the UI; secret fields are never returned by any read path. */
  public: boolean;
  optional: boolean;
  pattern?: string;
  help?: string;
}

/** A migration rule in a package manifest: how a legacy package secret becomes a credential entry. */
export interface CredentialMigrationSpec {
  name: string;
  /** Field id -> `secret:<secret id>` or `literal:<text>`. */
  fields?: Record<string, string>;
  /** One entry per `host=token` (or `host=user:token`) item of this legacy secret. */
  hostList?: { secret: string; hostField: string; tokenField: string; usernameField?: string };
  /** Mark the migrated entry the default for every server that has a widget of this package. */
  defaultForPackageServers?: boolean;
}

export interface CredentialKindDef {
  id: string;
  label: string;
  /** The permission needed to create, edit and delete an entry of this kind. */
  permission: string;
  /** The permission needed to see the public fields (defaults to `permission`). */
  viewPermission: string;
  fields: CredentialFieldDef[];
  /** How to pick an entry for a URL: `host` + the longest matching `scope`. */
  match?: { url: 'host+scope' };
  /** Whether an entry must name the servers it applies to (`required`) or may apply to all of them (`optional`). */
  servers: 'required' | 'optional';
  /** Each server may have one default entry of this kind. */
  defaultPerServer: boolean;
  migrate: CredentialMigrationSpec[];
}

/** The environment variable name a field of a resolved entry reaches a script as. */
export function credentialEnvName(kindId: string, fieldId: string): string {
  const part = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `BOSUN_CRED_${part(kindId)}_${part(fieldId)}`;
}

const REGEX_CACHE = new Map<string, RegExp | null>();
function safeRegex(pattern: string): RegExp | null {
  if (REGEX_CACHE.has(pattern)) return REGEX_CACHE.get(pattern) ?? null;
  let re: RegExp | null = null;
  try { re = new RegExp(pattern); } catch { re = null; }
  REGEX_CACHE.set(pattern, re);
  return re;
}

/**
 * Validate the `credentials` array of a manifest. `own` is the set of permissions the package declares and `secrets`
 * the legacy package secrets it declares (named by migration rules).
 */
export function validateCredentialKinds(
  raw: unknown,
  own: ReadonlySet<string>,
  secrets: ReadonlySet<string> = new Set(),
): Validated<CredentialKindDef[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_CREDENTIAL_KINDS) return fail(`"credentials" must list at most ${MAX_CREDENTIAL_KINDS} kinds`);
  const out: CredentialKindDef[] = [];
  const ids = new Set<string>();
  for (const k of raw as Record<string, unknown>[]) {
    if (!isObj(k)) return fail('each entry of "credentials" must be an object');
    const id = typeof k.id === 'string' ? k.id : '';
    if (!ID_RE.test(id) || ids.has(id)) return fail(`credential kind ids are lowercase letters, digits and underscores, and unique (got "${id}")`);
    ids.add(id);
    const label = text(k.label, 80);
    if (!label) return fail(`credential kind "${id}" needs a label (max 80 characters)`);
    if (typeof k.permission !== 'string' || !own.has(k.permission)) return fail(`credential kind "${id}": "permission" must be one of the permissions this package declares`);
    let viewPermission = k.permission as string;
    if (k.view_permission !== undefined) {
      if (typeof k.view_permission !== 'string' || !own.has(k.view_permission)) return fail(`credential kind "${id}": "view_permission" must be one of the permissions this package declares`);
      viewPermission = k.view_permission;
    }

    if (!Array.isArray(k.fields) || k.fields.length < 1 || k.fields.length > MAX_CREDENTIAL_FIELDS) {
      return fail(`credential kind "${id}": "fields" must list 1-${MAX_CREDENTIAL_FIELDS} fields`);
    }
    const fields: CredentialFieldDef[] = [];
    const fieldIds = new Set<string>();
    for (const f of k.fields as Record<string, unknown>[]) {
      if (!isObj(f)) return fail(`credential kind "${id}": each field must be an object`);
      const fid = typeof f.id === 'string' ? f.id : '';
      if (!ID_RE.test(fid) || fieldIds.has(fid)) return fail(`credential kind "${id}": field ids are lowercase letters, digits and underscores, and unique (got "${fid}")`);
      fieldIds.add(fid);
      if (f.type !== 'string' && f.type !== 'secret') return fail(`credential kind "${id}", field "${fid}": "type" must be "string" or "secret"`);
      const type = f.type as CredentialFieldType;
      const isPublic = f.public === undefined ? type === 'string' : f.public === true;
      if (type === 'secret' && isPublic) return fail(`credential kind "${id}", field "${fid}": a secret field cannot be public`);
      const flabel = f.label === undefined ? fid : text(f.label, 80);
      if (!flabel) return fail(`credential kind "${id}", field "${fid}": "label" must be short text`);
      let pattern: string | undefined;
      if (f.pattern !== undefined) {
        if (type !== 'string' || typeof f.pattern !== 'string' || f.pattern.length > 200 || !safeRegex(f.pattern)) {
          return fail(`credential kind "${id}", field "${fid}": "pattern" must be a regular expression for a string field`);
        }
        pattern = f.pattern;
      }
      const help = f.help === undefined ? undefined : text(f.help, 300);
      if (help === null) return fail(`credential kind "${id}", field "${fid}": "help" must be text (max 300 characters)`);
      if (f.optional !== undefined && typeof f.optional !== 'boolean') return fail(`credential kind "${id}", field "${fid}": "optional" must be true or false`);
      fields.push({ id: fid, label: flabel, type, public: isPublic, optional: f.optional === true, ...(pattern ? { pattern } : {}), ...(help ? { help } : {}) });
    }

    let match: { url: 'host+scope' } | undefined;
    if (k.match !== undefined) {
      if (!isObj(k.match) || k.match.url !== 'host+scope') return fail(`credential kind "${id}": "match" must be { "url": "host+scope" }`);
      const host = fields.find(f => f.id === 'host');
      const scope = fields.find(f => f.id === 'scope');
      if (!host || host.type !== 'string' || !scope || scope.type !== 'string') {
        return fail(`credential kind "${id}": matching by URL needs string fields "host" and "scope"`);
      }
      match = { url: 'host+scope' };
    }

    const servers = k.servers === undefined ? 'optional' : k.servers;
    if (servers !== 'required' && servers !== 'optional') return fail(`credential kind "${id}": "servers" must be "required" or "optional"`);
    if (k.default_per_server !== undefined && typeof k.default_per_server !== 'boolean') return fail(`credential kind "${id}": "default_per_server" must be true or false`);

    const migrate: CredentialMigrationSpec[] = [];
    if (k.migrate !== undefined) {
      if (!Array.isArray(k.migrate) || k.migrate.length > MAX_CREDENTIAL_MIGRATIONS) return fail(`credential kind "${id}": "migrate" must list at most ${MAX_CREDENTIAL_MIGRATIONS} rules`);
      for (const m of k.migrate as Record<string, unknown>[]) {
        const where = `credential kind "${id}" migration`;
        if (!isObj(m)) return fail(`${where}: each rule must be an object`);
        const name = text(m.name, MAX_CREDENTIAL_NAME);
        if (!name) return fail(`${where}: a name is required`);
        const rule: CredentialMigrationSpec = { name };
        if (m.fields !== undefined) {
          if (!isObj(m.fields) || Object.keys(m.fields).length < 1) return fail(`${where} "${name}": "fields" must map field ids to secret:<id> or literal:<text>`);
          const mapped: Record<string, string> = {};
          for (const [fieldId, src] of Object.entries(m.fields)) {
            const field = fields.find(f => f.id === fieldId);
            if (!field) return fail(`${where} "${name}": no field "${fieldId}" in this kind`);
            if (typeof src !== 'string') return fail(`${where} "${name}": field "${fieldId}" must be secret:<id> or literal:<text>`);
            if (src.startsWith('literal:')) {
              if (src.slice(8).length > 300) return fail(`${where} "${name}": literal value is too long`);
            } else if (src.startsWith('secret:')) {
              const sid = src.slice(7);
              if (!secrets.has(sid)) return fail(`${where} "${name}": the package does not declare the secret "${sid}"`);
            } else {
              return fail(`${where} "${name}": field "${fieldId}" must be secret:<id> or literal:<text>`);
            }
            mapped[fieldId] = src;
          }
          rule.fields = mapped;
        }
        if (m.host_list !== undefined) {
          const h = m.host_list;
          if (!isObj(h) || typeof h.secret !== 'string' || !secrets.has(h.secret)) return fail(`${where} "${name}": "host_list.secret" must name a secret this package declares`);
          for (const key of ['hostField', 'tokenField'] as const) {
            if (typeof h[key] !== 'string' || !fields.some(f => f.id === h[key])) return fail(`${where} "${name}": "host_list.${key}" must name a field of this kind`);
          }
          if (h.usernameField !== undefined && (typeof h.usernameField !== 'string' || !fields.some(f => f.id === h.usernameField))) {
            return fail(`${where} "${name}": "host_list.usernameField" must name a field of this kind`);
          }
          const tokenField = fields.find(f => f.id === h.tokenField)!;
          if (tokenField.type !== 'secret') return fail(`${where} "${name}": "host_list.tokenField" must be a secret field`);
          rule.hostList = { secret: h.secret, hostField: h.hostField as string, tokenField: h.tokenField as string, ...(h.usernameField ? { usernameField: h.usernameField as string } : {}) };
        }
        if (!rule.fields && !rule.hostList) return fail(`${where} "${name}": give "fields" or "host_list"`);
        if (m.default_for_package_servers !== undefined && typeof m.default_for_package_servers !== 'boolean') return fail(`${where} "${name}": "default_for_package_servers" must be true or false`);
        if (m.default_for_package_servers === true) rule.defaultForPackageServers = true;
        migrate.push(rule);
      }
    }

    out.push({ id, label, permission: k.permission, viewPermission, fields, ...(match ? { match } : {}), servers, defaultPerServer: k.default_per_server === true, migrate });
  }
  return { ok: true, value: out };
}

export interface CredentialValues {
  publicFields: Record<string, string>;
  secretFields: Record<string, string>;
}

/**
 * Validate the values of one entry. Secrets are never echoed back; `previousSecrets` are the ids already stored (so an
 * edit leaves them unchanged unless a new value is typed). `partial` is an edit: absent values stay as they were.
 */
export function validateCredentialValues(
  kind: CredentialKindDef,
  input: { fields?: unknown; secrets?: unknown },
  opts: { partial?: boolean; previousSecrets?: ReadonlySet<string> } = {},
): Validated<CredentialValues> {
  const fields = isObj(input.fields) ? input.fields : {};
  const secrets = isObj(input.secrets) ? input.secrets : {};
  const publicFields: Record<string, string> = {};
  const secretFields: Record<string, string> = {};
  for (const field of kind.fields) {
    if (field.type === 'secret') {
      const raw = secrets[field.id];
      if (raw === undefined) {
        if (!field.optional && !opts.partial && !opts.previousSecrets?.has(field.id)) return fail(`"${field.label}" is required`);
        continue;
      }
      if (raw === null) { secretFields[field.id] = ''; continue; }
      if (typeof raw !== 'string') return fail(`"${field.label}" must be text`);
      const value = raw.trim();
      if (value.length === 0) {
        if (!field.optional && !opts.partial && !opts.previousSecrets?.has(field.id)) return fail(`"${field.label}" is required`);
        continue;
      }
      if (value.length > MAX_CREDENTIAL_VALUE || /[\u0000-\u001f\u007f]/.test(value)) return fail(`"${field.label}" must be 1-${MAX_CREDENTIAL_VALUE} characters on one line`);
      secretFields[field.id] = value;
      continue;
    }
    const raw = fields[field.id];
    if (raw === undefined) {
      if (!field.optional && !opts.partial) return fail(`"${field.label}" is required`);
      continue;
    }
    if (typeof raw !== 'string') return fail(`"${field.label}" must be text`);
    const value = raw.trim();
    if (value.length === 0) {
      if (!field.optional && !opts.partial) return fail(`"${field.label}" is required`);
      continue;
    }
    if (value.length > 300) return fail(`"${field.label}" is too long`);
    if (field.pattern) {
      const re = safeRegex(field.pattern);
      if (!re || !re.test(value)) return fail(`"${field.label}" has an invalid format`);
    }
    publicFields[field.id] = value;
  }
  return { ok: true, value: { publicFields, secretFields } };
}

/** Validate a name and a server list for an entry. */
export function validateCredentialMeta(kind: CredentialKindDef, name: unknown, servers: unknown): Validated<{ name: string; servers: string[] }> {
  const n = text(name, MAX_CREDENTIAL_NAME);
  if (!n) return fail('A name is required (max 80 characters)');
  if (servers === undefined) servers = [];
  if (!Array.isArray(servers) || servers.length > 200 || servers.some(s => typeof s !== 'string' || s.length === 0 || s.length > 128)) {
    return fail('"servers" must be a list of server ids');
  }
  const list = Array.from(new Set(servers as string[]));
  if (kind.servers === 'required' && list.length === 0) return fail('Choose at least one server for this entry');
  return { ok: true, value: { name: n, servers: list } };
}

/** Parse an https repository URL into its host (lowercase, with a port when given) and path segments. */
export function parseRepositoryUrl(url: string): { host: string; path: string[] } | null {
  const m = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(String(url).trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(host)) return null;
  const path = (m[2] ?? '').split('/').map(s => s.trim()).filter(Boolean);
  return path.length ? { host, path } : null;
}

export interface MatchableCredential {
  id: string;
  name: string;
  /** Public fields of the entry (at least `host` and `scope`). */
  fields: Record<string, string>;
  servers: string[];
  isDefault: boolean;
  updatedAt?: string;
}

/**
 * Pick the entry for a repository URL: same host, then the longest scope that is a prefix of the repository path
 * (`owner/repo` beats `owner` beats the whole host). A server-specific entry beats an entry for all servers at the same
 * scope. Returns null when nothing matches.
 */
export function matchCredentialByUrl(entries: MatchableCredential[], url: string): MatchableCredential | null {
  const parsed = parseRepositoryUrl(url);
  if (!parsed) return null;
  const candidates: { entry: MatchableCredential; rank: number; specific: number }[] = [];
  for (const entry of entries) {
    const host = String(entry.fields.host ?? '').toLowerCase();
    if (host !== parsed.host) continue;
    const scope = String(entry.fields.scope ?? '').trim();
    let rank = 0;
    if (scope) {
      const parts = scope.toLowerCase().split('/').filter(Boolean);
      if (parts.length > parsed.path.length) continue;
      if (parts.some((p, i) => p !== parsed.path[i].toLowerCase())) continue;
      rank = parts.length;
    }
    candidates.push({ entry, rank, specific: entry.servers.length ? 1 : 0 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank || b.specific - a.specific || String(b.entry.updatedAt ?? '').localeCompare(String(a.entry.updatedAt ?? '')) || a.entry.id.localeCompare(b.entry.id));
  return candidates[0].entry;
}

/** The entry a server uses by default, if one is marked so. */
export function defaultCredentialForServer(entries: MatchableCredential[], serverId: string): MatchableCredential | null {
  const allowed = entries.filter(e => !e.servers.length || e.servers.includes(serverId));
  return allowed.find(e => e.isDefault) ?? null;
}

export interface LegacySecretValues { [secretId: string]: string | undefined }

export interface PlannedCredential {
  id: string;
  name: string;
  publicFields: Record<string, string>;
  secretFields: Record<string, string>;
  servers: string[];
  isDefault: boolean;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'entry';

/**
 * Turn the legacy package secrets of a kind into entries (pure). Deterministic ids make a second run harmless. An
 * entry is left out when the legacy values it needs are empty, so a half-filled configuration migrates nothing.
 */
export function planCredentialMigration(
  kind: CredentialKindDef,
  legacy: LegacySecretValues,
  packageServers: string[],
): PlannedCredential[] {
  const out: PlannedCredential[] = [];
  const fieldOf = (id: string) => kind.fields.find(f => f.id === id);
  for (const rule of kind.migrate) {
    if (rule.hostList) {
      const h = rule.hostList;
      const raw = legacy[h.secret] ?? '';
      const pairs = parseHostList(raw);
      for (const pair of pairs) {
        const publicFields: Record<string, string> = { [h.hostField]: pair.host };
        const secretFields: Record<string, string> = {};
        const tokenField = fieldOf(h.tokenField);
        if (tokenField?.type === 'secret') secretFields[h.tokenField] = pair.token; else publicFields[h.tokenField] = pair.token;
        if (h.usernameField && pair.username !== undefined) {
          const uf = fieldOf(h.usernameField);
          if (uf?.type === 'secret') secretFields[h.usernameField] = pair.username; else publicFields[h.usernameField] = pair.username;
        }
        out.push({
          id: `mig_${kind.id}_${slug(pair.host)}`,
          name: rule.name.replace(/\{host\}/g, pair.host),
          publicFields, secretFields, servers: [], isDefault: false,
        });
      }
      continue;
    }
    if (!rule.fields) continue;
    const publicFields: Record<string, string> = {};
    const secretFields: Record<string, string> = {};
    let hasValue = false;
    let complete = true;
    for (const [fieldId, src] of Object.entries(rule.fields)) {
      const field = fieldOf(fieldId);
      if (!field) { complete = false; continue; }
      const value = src.startsWith('literal:') ? src.slice(8) : (legacy[src.slice(7)] ?? '').trim();
      if (value) hasValue = true;
      if (!value) {
        if (!field.optional) complete = false;
        continue;
      }
      if (field.type === 'secret') secretFields[fieldId] = value; else publicFields[fieldId] = value;
    }
    if (!hasValue || !complete) continue;
    const servers = rule.defaultForPackageServers ? Array.from(new Set(packageServers)) : [];
    out.push({
      id: `mig_${kind.id}_${slug(rule.name)}`,
      name: rule.name, publicFields, secretFields, servers,
      isDefault: rule.defaultForPackageServers === true,
    });
  }
  return out;
}

/** `host=token` and `host=user:token` items, separated by spaces, commas or semicolons. */
export function parseHostList(raw: string): { host: string; username?: string; token: string }[] {
  const out: { host: string; username?: string; token: string }[] = [];
  for (const item of String(raw).split(/[\s,;]+/)) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const host = item.slice(0, eq).toLowerCase();
    const value = item.slice(eq + 1);
    if (!host || !value || !/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(host)) continue;
    const colon = value.indexOf(':');
    if (colon > 0) out.push({ host, username: value.slice(0, colon), token: value.slice(colon + 1) });
    else out.push({ host, token: value });
  }
  return out;
}
