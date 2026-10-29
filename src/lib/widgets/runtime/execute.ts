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
  /** Set when the host cannot provide this data (for example Docker is not installed): shown instead of rows. */
  unavailable?: string;
}

/** A widget's data: the poller's snapshot section, or the output of its command (cached and shared between viewers). */
export async function loadRuntimeData(serverId: string, loaded: LoadedSpec, force = false, config: Record<string, unknown> = {}): Promise<RuntimeData> {
  const ds: DataSpec = loaded.spec.data;
  if (ds.source === 'snapshot') {
    const r = await rqlite.query('SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, ds.section]);
    const row = r.values?.[0];
    if (!row) return { data: null, collectedAt: null, pending: true };
    let parsed: unknown = null;
    try { parsed = JSON.parse(String(row[0])); } catch { parsed = null; }
    const collectedAt = new Date(Number(row[1])).toISOString();
    if (ds.unavailable && evalCond(ds.unavailable.when, parsed)) return { data: null, collectedAt, pending: false, unavailable: fillTemplate(ds.unavailable.message, parsed) };
    return { data: applyConfigFilters(shapeData(ds, parsed), ds.filter, config), collectedAt, pending: false };
  }

  // Command-sourced data is collected by the poller (see lib/collect/packages.js) and stored as the host
  // snapshot section `pkg:<type>`, so opening a dashboard never runs an SSH command from the web process.
  const r = await rqlite.query('SELECT data, collected_at FROM host_snapshots WHERE server_id = ? AND section = ?', [serverId, `pkg:${loaded.type}`]);
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
