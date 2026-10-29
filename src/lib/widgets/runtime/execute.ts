/**
 * Server side of the declarative widget runtime: finding a widget type's spec, running its
 * actions and fetching its data. Everything here is called after the route has authenticated
 * the caller and checked the permission the spec names.
 */
import crypto from 'crypto';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { runOnServerId } from '@/lib/ssh/connection-pool';
import { loadShellTarget, assertShellAccountSafe, runOnShellTarget, ShellUnavailableError } from '@/lib/ssh/shell-target';
import { validateWidgetSpec, type ActionSpec, type DataSpec, type RunAs, type WidgetSpec } from '@/lib/widgets/runtime/spec';
import { commandFor, renderCommand, validateParams } from '@/lib/widgets/runtime/command';
import { parseOutput, shapeData } from '@/lib/widgets/runtime/data';

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
}

const SPEC_TTL_MS = 15_000;
const g = globalThis as unknown as { __bosunSpecCache?: Map<string, { at: number; value: LoadedSpec | null }>; __bosunDataCache?: Map<string, { at: number; value: unknown; pending?: Promise<unknown> }> };
const specCache = g.__bosunSpecCache ?? (g.__bosunSpecCache = new Map());
const dataCache = g.__bosunDataCache ?? (g.__bosunDataCache = new Map());

/** Forget cached specs and command results (after a package is installed or removed). */
export function invalidateRuntimeCache(): void {
  specCache.clear();
  dataCache.clear();
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
    const v = validateWidgetSpec(raw, (perms.values ?? []).map(p => String(p[0])));
    if (v.ok) value = { type, packageId: String(row.package_id), spec: v.value };
  }
  specCache.set(type, { at: Date.now(), value });
  return value;
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
}

/**
 * Run a command as the account the spec asks for: `service` is the privileged service account,
 * `shell` the non-admin account (re-verified first, Linux only).
 */
async function runAs(server: ServerInfo, as: RunAs, command: string, timeoutSec: number): Promise<CommandOutput> {
  try {
    if (as === 'shell') {
      const target = await loadShellTarget(server.id);
      await assertShellAccountSafe(target);
      const r = await runOnShellTarget(target, command, { timeoutMs: timeoutSec * 1000 });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut };
    }
    const r = await runOnServerId(server.id, command, { timeoutMs: timeoutSec * 1000 });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut };
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

export interface RuntimeData {
  data: unknown;
  collectedAt: string | null;
  pending: boolean;
}

/** A widget's data: the poller's snapshot section, or the output of its command (cached and shared between viewers). */
export async function loadRuntimeData(serverId: string, loaded: LoadedSpec, force = false): Promise<RuntimeData> {
  const ds: DataSpec = loaded.spec.data;
  if (ds.source === 'snapshot') {
    const r = await rqlite.query('SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, ds.section]);
    const row = r.values?.[0];
    if (!row) return { data: null, collectedAt: null, pending: true };
    let parsed: unknown = null;
    try { parsed = JSON.parse(String(row[0])); } catch { parsed = null; }
    return { data: shapeData(ds, parsed), collectedAt: new Date(Number(row[1])).toISOString(), pending: false };
  }

  const server = await loadServer(serverId);
  const template = commandFor({ command: ds.command, windowsCommand: ds.windowsCommand }, server.platform);
  if (template === null) throw new RuntimeError('This widget is not available on Windows hosts', 409, 'PLATFORM_UNSUPPORTED');
  const key = `${serverId}|${loaded.type}|${crypto.createHash('sha1').update(`${ds.as}|${template}`).digest('hex')}`;
  const hit = dataCache.get(key);
  if (!force && hit && !hit.pending && Date.now() - hit.at < ds.cacheSec * 1000) {
    return { data: hit.value, collectedAt: new Date(hit.at).toISOString(), pending: false };
  }
  // One run at a time per host and command; concurrent viewers share its result.
  if (hit?.pending) await hit.pending.catch(() => undefined);
  const again = dataCache.get(key);
  if (!force && again && !again.pending && Date.now() - again.at < ds.cacheSec * 1000) {
    return { data: again.value, collectedAt: new Date(again.at).toISOString(), pending: false };
  }
  const run = (async () => {
    const out = await runAs(server, ds.as, template, ds.timeoutSec);
    if (out.timedOut) throw new RuntimeError('The command timed out', 504, 'TIMEOUT');
    if (out.exitCode !== 0) throw new RuntimeError((out.stderr || out.stdout).trim().slice(0, 300) || `The command failed (exit ${out.exitCode})`, 502, 'COMMAND_FAILED');
    let parsed: unknown;
    try { parsed = parseOutput(ds.parse, out.stdout.slice(0, MAX_OUTPUT)); } catch (e) { throw new RuntimeError((e as Error).message, 502, 'PARSE_FAILED'); }
    return shapeData(ds, parsed);
  })();
  dataCache.set(key, { at: Date.now(), value: undefined, pending: run });
  try {
    const value = await run;
    dataCache.set(key, { at: Date.now(), value });
    return { data: value, collectedAt: new Date().toISOString(), pending: false };
  } catch (err) {
    dataCache.delete(key);
    throw err;
  } finally {
    if (dataCache.size > 500) dataCache.clear();
  }
}
