/**
 * Server side of the declarative widget runtime: finding a widget type's spec, running its
 * actions and fetching its data. Everything here is called after the route has authenticated
 * the caller and checked the permission the spec names.
 */

import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { loadShellTarget, assertShellAccountSafe, runOnShellTarget, ShellUnavailableError } from '@/lib/ssh/shell-target';
import { validateWidgetSpec, applyConfigFilters, evalCond, fillTemplate, type ActionSpec, type DataSpec, type RunAs, type WidgetSpec } from '@/lib/widgets/runtime/spec';
import { commandFor, renderCommand, validateParams } from '@/lib/widgets/runtime/command';
import { shapeData } from '@/lib/widgets/runtime/data';
import { buildScriptInvocation, buildCancelInvocation, parseScriptOutput, scriptFileFor, validateParamValues } from '@/lib/widgets/runtime/script-run';
import { typedParams, selectVariant, resolveScriptArgs, type ActionContext } from '@/lib/widgets/runtime/script-action';
import { getPackageFile } from '@/lib/widgets/materialize-db';
import { loadLookups } from '@/lib/widgets/runtime/lookups';
import { dataSectionFor } from '@/lib/widgets/runtime/store-data';
import { getPackageSecrets } from '@/lib/widgets/package-secrets';

export class RuntimeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'RUNTIME_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LoadedSpec {
  type: string;
  packageId: string;
  spec: WidgetSpec;
  /** Hosts the package's manifest lets its lookups contact. */
  network: string[];
}

const SPEC_TTL_MS = 15_000;
const g = globalThis as unknown as { __bosunSpecCache?: Map<string, { at: number; value: LoadedSpec | null }> };
const specCache = g.__bosunSpecCache ?? (g.__bosunSpecCache = new Map());
const pollRequested = new Map<string, number>();

/** Forget cached specs and command results (after a package is installed or removed). */
export function invalidateRuntimeCache(): void {
  specCache.clear();
}

/**
 * The spec of an enabled, package-provided widget type, or null when the type has none.
 * The stored spec is validated again against the package's registered permissions, so a
 * row that was changed outside the package installer is never run.
 */
export async function loadWidgetSpec(type: string): Promise<LoadedSpec | null> {
  const hit = specCache.get(type);
  if (hit && Date.now() - hit.at < SPEC_TTL_MS) return hit.value;
  let value: LoadedSpec | null = null;
  const r = await rqlite.query('SELECT package_id, spec, enabled FROM custom_widgets WHERE type = ? AND package_id IS NOT NULL AND spec IS NOT NULL', [type]);
  const row = rowsToObjects(r)[0];
  if (row && Number(row.enabled) === 1) {
    const perms = await rqlite.query('SELECT id FROM permission_definitions WHERE source = ?', [`package:${row.package_id}`]);
    let raw: unknown = null;
    try { raw = JSON.parse(String(row.spec)); } catch { raw = null; }
    const v = validateWidgetSpec(raw, (perms.values ?? []).map(p => String(p[0])), String(row.package_id));
    if (v.ok) value = { type, packageId: String(row.package_id), spec: v.value, network: await networkOf(String(row.package_id)) };
  }
  specCache.set(type, { at: Date.now(), value });
  return value;
}

async function networkOf(packageId: string): Promise<string[]> {
  const r = rowsToObjects(await rqlite.query('SELECT manifest FROM widget_packages WHERE id = ?', [packageId]))[0];
  try {
    const m = JSON.parse(String(r?.manifest ?? '{}'));
    return Array.isArray(m.network) ? m.network.filter((h: unknown): h is string => typeof h === 'string') : [];
  } catch { return []; }
}

interface ServerInfo { id: string; platform: 'linux' | 'windows' }

async function loadServer(serverId: string): Promise<ServerInfo> {
  const r = await rqlite.query('SELECT id, platform FROM servers WHERE id = ?', [serverId]);
  const row = r.values?.[0];
  if (!row) throw new RuntimeError('Server not found', 404, 'NOT_FOUND');
  return { id: String(row[0]), platform: row[1] === 'windows' ? 'windows' : 'linux' };
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Stopped because the caller aborted (a cancelled job). */
  aborted?: boolean;
}

/** Extras for a long-running run: live output and a way to stop it. */
export interface RunExtras {
  onData?: (text: string, isErr: boolean) => void;
  signal?: AbortSignal;
}

/**
 * Run a command as the account the spec asks for: `service` is the privileged service account,
 * `shell` the non-admin account (re-verified first, Linux only).
 */
async function runAs(server: ServerInfo, as: RunAs, command: string, timeoutSec: number, stdin?: string, extra: RunExtras = {}): Promise<CommandOutput> {
  try {
    if (as === 'shell') {
      const target = await loadShellTarget(server.id);
      await assertShellAccountSafe(target);
      const r = await runOnShellTarget(target, command, { timeoutMs: timeoutSec * 1000, stdin, ...extra });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted };
    }
    const r = await runOnServerId(server.id, command, { timeoutMs: timeoutSec * 1000, stdin, ...extra });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted };
  } catch (err) {
    if (err instanceof ShellUnavailableError) throw new RuntimeError(err.message, err.status, err.code);
    throw err;
  }
}

export interface ActionResult extends CommandOutput {
  success: boolean;
}

export const MAX_OUTPUT = 256 * 1024;

/** Validate the parameters, render the command for the host's platform and run it. */
export async function runAction(serverId: string, action: ActionSpec, params: unknown): Promise<ActionResult> {
  if (action.kind === 'screen') throw new RuntimeError('This action only opens a screen in the web UI', 400, 'NOT_RUNNABLE');
  if (action.kind === 'terminal') {
    throw new RuntimeError('This action opens a terminal, not a command: call it through the widget-actions endpoint to get an API terminal token.', 400, 'NOT_RUNNABLE');
  }
  const server = await loadServer(serverId);
  const template = commandFor(action, server.platform);
  if (template === null) throw new RuntimeError(`"${action.label}" is not available on Windows hosts`, 409, 'PLATFORM_UNSUPPORTED');
  const values = validateParams(action, params);
  const command = renderCommand(template, values, server.platform);
  const out = await runAs(server, action.as, command, action.timeoutSec);
  return { ...out, stdout: out.stdout.slice(0, MAX_OUTPUT), stderr: out.stderr.slice(0, 64 * 1024), success: out.exitCode === 0 && !out.timedOut };
}

export interface ScriptResult extends ActionResult {
  /** The generic output protocol of the script (steps, progress, DONE / ERROR). */
  protocol: ReturnType<typeof parseScriptOutput>;
}

/**
 * Run one of a package's host scripts on a server, as the account the script declares. The parameters are validated
 * against the script's declaration and reach the script as data (environment variables), never as part of its text.
 */
export async function runScript(serverId: string, loaded: LoadedSpec, scriptId: string, args: unknown, ext: RunExtras & { jobId?: string } = {}): Promise<ScriptResult> {
  const script = loaded.spec.scripts?.[scriptId];
  if (!script) throw new RuntimeError(`The package has no script "${scriptId}"`, 404, 'SCRIPT_NOT_FOUND');
  const server = await loadServer(serverId);
  const file = scriptFileFor(script, server.platform);
  if (!file) throw new RuntimeError(`This script is not available on ${server.platform === 'windows' ? 'Windows' : 'Linux'} hosts`, 409, 'PLATFORM_UNSUPPORTED');
  const text = await getPackageFile(loaded.packageId, file);
  if (text === null) throw new RuntimeError(`The package file "${file}" is missing`, 500, 'SCRIPT_MISSING');
  const values = validateParamValues(script.params, args);
  const secrets = script.secrets?.length ? await getPackageSecrets(loaded.packageId, script.secrets) : {};
  const inv = buildScriptInvocation(server.platform, text, values, { jobId: ext.jobId, secrets });
  // Whatever a script prints, a secret it was given never leaves it (live output included).
  const secretValues = Object.values(secrets).filter(v => v.length >= 4);
  const scrub = (s: string) => secretValues.reduce((acc, v) => acc.split(v).join('***'), s);
  const onData = ext.onData && secretValues.length ? (t: string, isErr: boolean) => ext.onData!(scrub(t), isErr) : ext.onData;
  const out = await runAs(server, script.as, inv.command, script.timeoutSec, inv.stdin, { onData, signal: ext.signal });
  const stdout = scrub(out.stdout).slice(0, MAX_OUTPUT);
  return { ...out, stdout, stderr: scrub(out.stderr).slice(0, 64 * 1024), success: out.exitCode === 0 && !out.timedOut, protocol: parseScriptOutput(stdout) };
}

const datasetCache = new Map<string, { at: number; value: unknown }>();
const MAX_DATASET_CACHE = 200;

/**
 * Load a dataset of a screen: run its (read-only) script and parse the JSON it printed. Results are reused for the dataset's
 * `cacheSec` (per server and arguments), so several people looking at the same screen cost one run. The run goes through the
 * shared connection of the host, like an action; it is started by a person with a screen open, never in the background.
 */
export async function loadDataset(serverId: string, loaded: LoadedSpec, datasetId: string, rawArgs: unknown): Promise<{ data: unknown; collectedAt: string }> {
  const ds = loaded.spec.datasets?.[datasetId];
  const script = ds ? loaded.spec.scripts?.[ds.script] : undefined;
  if (!ds || !script) throw new RuntimeError('Unknown dataset', 404, 'NOT_FOUND');
  const given = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...(rawArgs as Record<string, unknown>) } : {};
  for (const [name, spec] of Object.entries(script.params)) if (given[name] === undefined && spec.default !== undefined) given[name] = spec.default;
  const values = validateParamValues(script.params, given);
  const key = `${serverId}|${loaded.type}|${datasetId}|${JSON.stringify(values)}`;
  const hit = datasetCache.get(key);
  if (ds.cacheSec > 0 && hit && Date.now() - hit.at < ds.cacheSec * 1000) return { data: hit.value, collectedAt: new Date(hit.at).toISOString() };
  const r = await runScript(serverId, loaded, ds.script, values);
  if (r.protocol.error) throw new RuntimeError(r.protocol.error, 502, 'DATASET_FAILED');
  if (r.timedOut) throw new RuntimeError('The host took too long to answer', 504, 'DATASET_TIMEOUT');
  const out = r.stdout.trim();
  let data: unknown;
  try { data = JSON.parse(out); } catch {
    // Tolerate banners or warnings before the document: the document is the last line that starts a JSON value.
    const line = out.split('\n').reverse().find(l => /^[[{]/.test(l.trim()));
    try { data = line ? JSON.parse(line) : undefined; } catch { data = undefined; }
  }
  if (data === undefined) throw new RuntimeError(r.success ? 'The script did not print JSON' : (r.stderr.trim().split('\n').pop() || 'The script failed').slice(0, 300), 502, 'DATASET_FAILED');
  if (datasetCache.size >= MAX_DATASET_CACHE) datasetCache.delete(datasetCache.keys().next().value as string);
  const now = Date.now();
  if (ds.cacheSec > 0) datasetCache.set(key, { at: now, value: data });
  return { data, collectedAt: new Date(now).toISOString() };
}

/** Stop a running job's script on the host (best effort; nothing happens when it has already finished). */
export async function cancelScript(serverId: string, loaded: LoadedSpec, scriptId: string, jobId: string): Promise<void> {
  const script = loaded.spec.scripts?.[scriptId];
  if (!script) return;
  const server = await loadServer(serverId);
  const inv = buildCancelInvocation(server.platform, jobId);
  await runAs(server, script.as, inv.command, 20);
}

export interface InstanceRef { id: string; config: Record<string, unknown> }

/** The settings of one widget on a server, when the caller names it and it is a widget of this type on this server. */
export async function loadInstance(serverId: string, widgetType: string, widgetId: unknown): Promise<InstanceRef | null> {
  if (typeof widgetId !== 'string' || !widgetId) return null;
  const r = rowsToObjects(await rqlite.query('SELECT id, config FROM widgets WHERE id = ? AND server_id = ? AND widget_type = ?', [widgetId, serverId, widgetType]))[0];
  if (!r) throw new RuntimeError('That widget is not a widget of this type on this server', 404, 'NOT_FOUND');
  let config: Record<string, unknown> = {};
  try { const c = JSON.parse(String(r.config ?? '{}')); if (c && typeof c === 'object' && !Array.isArray(c)) config = c; } catch { /* keep {} */ }
  return { id: String(r.id), config };
}

/** What conditions and arguments of a script action read: state, data, settings, lookups, the server and the parameters. */
export async function buildActionContext(serverId: string, loaded: LoadedSpec, instance: InstanceRef | null, param: ActionContext['param']): Promise<ActionContext> {
  const s = rowsToObjects(await rqlite.query('SELECT name, hostname, platform FROM servers WHERE id = ?', [serverId]))[0];
  if (!s) throw new RuntimeError('Server not found', 404, 'NOT_FOUND');
  const rt = await loadRuntimeData(serverId, loaded, false, instance?.config ?? {}, instance?.id).catch(() => null);
  return {
    state: rt?.state ?? null, data: rt?.data ?? null, config: instance?.config ?? {}, lookups: rt?.lookups ?? {},
    server: { name: s.name, hostname: s.hostname, platform: s.platform === 'windows' ? 'windows' : 'linux' }, param,
  };
}

export interface PreparedScript { scriptId: string; args: Record<string, unknown> }

/** Validate the action's parameters, pick the variant that applies to this host and work out the script's arguments. */
export async function prepareScriptAction(serverId: string, loaded: LoadedSpec, action: ActionSpec, rawParams: unknown, instance: InstanceRef | null): Promise<PreparedScript> {
  const validated = validateParams(action, rawParams);
  const ctx = await buildActionContext(serverId, loaded, instance, typedParams(action.params, validated));
  const variant = selectVariant(action, ctx);
  if (!variant) throw new RuntimeError(`"${action.label}" does not apply to this host right now`, 409, 'NOT_APPLICABLE');
  const script = loaded.spec.scripts?.[variant.script];
  if (!script) throw new RuntimeError(`The package has no script "${variant.script}"`, 404, 'SCRIPT_NOT_FOUND');
  return { scriptId: variant.script, args: resolveScriptArgs(variant, script, ctx) };
}

export interface RuntimeData {
  data: unknown;
  collectedAt: string | null;
  pending: boolean;
  /** Set when the host cannot provide this data (for example Docker is not installed): shown instead of rows. */
  unavailable?: string;
  /** Version 2: what the widget's state probe found on the host (null until the first run) and the values of its lookups. */
  state?: unknown;
  stateError?: string;
  lookups?: Record<string, string | null>;
}

/**
 * A widget that reads more than one section (or the server's own details) gets one object keyed by name:
 * `{ <section>: ..., <also>: ..., server: {...} }`, so a view can mix them (`{system.prettyName}`, `{metrics.cpu.usage}`).
 */
async function withExtras(serverId: string, ds: Extract<DataSpec, { source: 'snapshot' }>, main: unknown): Promise<unknown> {
  const out: Record<string, unknown> = { [ds.section]: main };
  if (ds.also?.length) {
    const r = await rqlite.query(`SELECT section, data FROM host_snapshots WHERE server_id = ? AND section IN (${ds.also.map(() => '?').join(',')})`, [serverId, ...ds.also]);
    for (const v of r.values ?? []) {
      try { out[String(v[0])] = JSON.parse(String(v[1])); } catch { /* unreadable section: leave it out */ }
    }
  }
  if (ds.server) {
    const s = await rqlite.query('SELECT id, name, hostname, platform, os_type, os_version, is_online, last_seen, last_error FROM servers WHERE id = ?', [serverId]);
    const o = rowsToObjects(s)[0];
    if (o) out.server = { ...o, is_online: !!o.is_online, platform: o.platform || 'linux' };
  }
  return out;
}

/** A widget's data: the poller's snapshot section, or the output of its command (cached and shared between viewers). */
export async function loadRuntimeData(serverId: string, loaded: LoadedSpec, force = false, config: Record<string, unknown> = {}, instanceId?: string): Promise<RuntimeData> {
  const base = await loadMainData(serverId, loaded, force, config, instanceId);
  const spec = loaded.spec;
  if (!spec.state && !spec.lookups) return base;
  const extra: Pick<RuntimeData, 'state' | 'stateError' | 'lookups'> = {};
  if (spec.state) {
    const r = await rqlite.query('SELECT data FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, `pkg:${loaded.type}:state`]);
    if (!r.values?.length) { extra.state = null; if (force) await requestPoll(serverId, true); } else {
      let s: { ok?: boolean; data?: unknown; error?: string } = {};
      try { s = JSON.parse(String(r.values[0][0])); } catch { s = { ok: false, error: 'The stored state is unreadable' }; }
      if (s.ok === false) { extra.state = null; extra.stateError = s.error || 'The state check failed'; } else extra.state = s.data ?? null;
    }
  }
  if (spec.lookups) extra.lookups = await loadLookups(loaded.packageId, spec.lookups, loaded.network);
  return { ...base, ...extra };
}

async function loadMainData(serverId: string, loaded: LoadedSpec, force: boolean, config: Record<string, unknown>, instanceId?: string): Promise<RuntimeData> {
  const ds: DataSpec = loaded.spec.data;
  if (ds.source === 'snapshot') {
    const r = await rqlite.query('SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, ds.section]);
    const row = r.values?.[0];
    if (!row) return { data: null, collectedAt: null, pending: true };
    let parsed: unknown = null;
    try { parsed = JSON.parse(String(row[0])); } catch { parsed = null; }
    const collectedAt = new Date(Number(row[1])).toISOString();
    if (ds.unavailable && evalCond(ds.unavailable.when, parsed)) return { data: null, collectedAt, pending: false, unavailable: fillTemplate(ds.unavailable.message, parsed) };
    if (ds.also?.length || ds.server) parsed = await withExtras(serverId, ds, parsed);
    return { data: applyConfigFilters(shapeData(ds, parsed), ds.filter, config), collectedAt, pending: false };
  }

  // Command-sourced data is collected by the poller (see lib/collect/packages.js) and stored as the host
  // snapshot section `pkg:<type>`, so opening a dashboard never runs an SSH command from the web process.
  const r = await rqlite.query('SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, dataSectionFor(loaded.type, ds, instanceId)]);
  const row = r.values?.[0];
  if (force || !row) await requestPoll(serverId, force);
  if (!row) return { data: null, collectedAt: null, pending: true };
  let stored: { ok?: boolean; data?: unknown; error?: string } = {};
  try { stored = JSON.parse(String(row[0])); } catch { stored = { ok: false, error: 'The stored result is unreadable' }; }
  if (stored.ok === false) {
    const msg = stored.error || 'The command failed';
    throw new RuntimeError(msg, /Windows hosts/.test(msg) ? 409 : 502, /Windows hosts/.test(msg) ? 'PLATFORM_UNSUPPORTED' : 'COMMAND_FAILED');
  }
  return { data: applyConfigFilters(stored.data ?? null, ds.filter, config), collectedAt: new Date(Number(row[1])).toISOString(), pending: false };
}

/** Ask the poller to collect this host now (when a widget has no data yet, or the person pressed Refresh). Not more than once every 10 s. */
async function requestPoll(serverId: string, force: boolean): Promise<void> {
  const now = Date.now();
  const last = pollRequested.get(serverId) ?? 0;
  if (now - last < (force ? 2_000 : 10_000)) return;
  pollRequested.set(serverId, now);
  await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [now, serverId]).catch(() => undefined);
}
