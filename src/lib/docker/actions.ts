import { runOnServerId } from '@/lib/ssh/connection-pool';
import { rqlite } from '@/lib/db/rqlite-client';

/** Docker container names / (short) IDs. Never passed through a shell unvalidated. */
export const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

export function isContainerAction(v: unknown): v is ContainerAction {
  return typeof v === 'string' && (CONTAINER_ACTIONS as readonly string[]).includes(v);
}

export function assertContainerRef(ref: string): void {
  if (!CONTAINER_REF_RE.test(ref)) throw Object.assign(new Error('Invalid container reference'), { status: 400 });
}

/**
 * The docker command for a host: plain `docker`, falling back to
 * non-interactive sudo when the SSH user is not in the docker group.
 */
function dockerCmd(args: string): string {
  return `out=$(docker ${args} 2>&1); rc=$?; if [ $rc -ne 0 ] && echo "$out" | grep -qi 'permission denied' && command -v sudo >/dev/null; then ` +
    `out=$(sudo -n docker ${args} 2>&1); rc=$?; fi; printf '%s\\n' "$out"; exit $rc`;
}

async function platformOf(serverId: string): Promise<'linux' | 'windows'> {
  const r = await rqlite.query('SELECT platform FROM servers WHERE id = ?', [serverId]);
  if (!r.values?.length) throw Object.assign(new Error('Server not found'), { status: 404 });
  return r.values[0][0] === 'windows' ? 'windows' : 'linux';
}

export interface ActionResult {
  success: boolean;
  output: string;
  exitCode: number;
}

export async function containerAction(serverId: string, ref: string, action: ContainerAction): Promise<ActionResult> {
  assertContainerRef(ref);
  const windows = (await platformOf(serverId)) === 'windows';
  const timeout = action === 'start' ? 60_000 : 90_000;
  const r = await runOnServerId(serverId, windows ? `docker.exe ${action} ${ref}` : dockerCmd(`${action} ${ref}`), { timeoutMs: timeout });
  const output = (r.stdout + r.stderr).trim().slice(0, 2000);
  return { success: r.exitCode === 0, output, exitCode: r.exitCode };
}

export async function containerLogs(serverId: string, ref: string, tail = 200): Promise<string> {
  assertContainerRef(ref);
  const n = Math.max(1, Math.min(2000, Math.round(tail)));
  const windows = (await platformOf(serverId)) === 'windows';
  const r = await runOnServerId(serverId, windows ? `docker.exe logs --tail ${n} ${ref} 2>&1` : dockerCmd(`logs --tail ${n} --timestamps ${ref}`), { timeoutMs: 20_000 });
  return (r.stdout + r.stderr).slice(-512 * 1024);
}

/** Ask the poller to refresh this host right away (after an action). */
export async function requestPoll(serverId: string): Promise<void> {
  await rqlite.execute('UPDATE servers SET poll_requested_at = ? WHERE id = ?', [Date.now(), serverId]).catch(() => undefined);
}
