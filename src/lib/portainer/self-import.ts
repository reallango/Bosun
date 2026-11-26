/**
 * Importing (and detaching) the stack this Bosun itself runs in, on the same node: needed on a single-node install, where
 * there is no other node to do it from.
 *
 * Re-creating the stack ends this process, so the work cannot simply be awaited. The stack widget stores the stack and
 * starts it from a job on the host after its action has answered (`stacks.startLater`), and Portainer's delete is preceded
 * by the host waiter (`stacks.guard`) as usual. What was asked is kept in app_config (`import.self.<node>`) and moved on by
 * `advanceSelfImport`: in this process a little after the deployment, and again by the restarted process (the update tasks
 * call it every 30 minutes, the first time a minute after start). Each step is claimed with a compare-and-set on the
 * record, so two processes never both act on it.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { isRole } from '@/lib/auth/levels';
import { getUserStatus } from '@/lib/auth/user-status';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { logAudit } from '@/lib/audit/logger';
import { nodeName } from '@/lib/network/node-host';
import { notify } from '@/lib/notifications/store';
import { loadDataset } from '@/lib/widgets/runtime/execute';
import { listStacks } from './client';
import { detachStack, stackManager } from './import'; // a cycle (import.ts starts self-imports); both are only used inside functions

export interface SelfImport {
  name: string;
  serverId: string;
  detach: boolean;
  portainer: { id: number; endpointId: number } | null;
  running: boolean;
  user: { id: string; username: string };
  phase: 'deploying' | 'detaching';
  at: string;
}

/** How long a self-import may take before it is reported as failed. */
const GIVE_UP_MS = 60 * 60_000;

export const selfKey = (node = nodeName()) => `import.self.${node.replace(/[^A-Za-z0-9_.-]/g, '_')}`;

async function read(key: string): Promise<{ raw: string; rec: SelfImport } | null> {
  const r = rowsToObjects(await rqlite.query('SELECT value FROM app_config WHERE key = ?', [key]))[0];
  if (!r) return null;
  try { return { raw: String(r.value), rec: JSON.parse(String(r.value)) as SelfImport }; } catch { return null; }
}

/** Start tracking a self-import; refuses while another one on this node is still under way. */
export async function beginSelfImport(rec: Omit<SelfImport, 'at' | 'phase'> & { phase?: SelfImport['phase'] }): Promise<boolean> {
  const value = JSON.stringify({ ...rec, phase: rec.phase ?? 'deploying', at: new Date().toISOString() });
  const r = await rqlite.execute(
    `INSERT INTO app_config (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO NOTHING`,
    [selfKey(), value, 'Import of this node\'s own Bosun stack, under way']);
  return Number(r.rows_affected ?? 0) === 1;
}

/** Replace the record only if it is still exactly `raw` (one process wins). null removes it. */
async function claim(key: string, raw: string, next: SelfImport | null): Promise<boolean> {
  const r = next
    ? await rqlite.execute('UPDATE app_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ? AND value = ?', [JSON.stringify(next), key, raw])
    : await rqlite.execute('DELETE FROM app_config WHERE key = ? AND value = ?', [key, raw]);
  return Number(r.rows_affected ?? 0) === 1;
}

export async function cancelSelfImport(): Promise<void> {
  await rqlite.execute('DELETE FROM app_config WHERE key = ?', [selfKey()]).catch(() => undefined);
}

/** The person who asked, as a principal again, if they still hold Full access. */
async function asker(u: SelfImport['user']): Promise<TokenPayload | null> {
  const s = await getUserStatus(u.id).catch(() => null);
  if (!s || s.disabled || !isRole(s.role) || s.role !== 'admin') return null;
  return { userId: u.id, username: u.username, role: s.role, authType: 'session' };
}

async function done(rec: SelfImport, ok: boolean, title: string, message: string): Promise<void> {
  await notify({ kind: 'alert', severity: ok ? 'success' : 'warning', title, message: message.slice(0, 1900), serverId: rec.serverId, audience: 'admin' });
  await logAudit({ userId: rec.user.id, serverId: rec.serverId, action: 'stack.import_self', category: 'stacks', status: ok ? 'success' : 'failure', details: `${rec.name}: ${message}`.slice(0, 900) }).catch(() => undefined);
}

/**
 * Move this node's self-import on: once Bosun's copy runs the stack, report it and (when asked) detach from Portainer;
 * after the restart that Portainer's delete causes, report whether Portainer let go. Safe to call at any time.
 */
export async function advanceSelfImport(): Promise<void> {
  const key = selfKey();
  const cur = await read(key);
  if (!cur) return;
  const { raw, rec } = cur;
  if (Date.now() - Date.parse(rec.at) > GIVE_UP_MS) {
    if (await claim(key, raw, null)) await done(rec, false, `Importing ${rec.name} did not finish`, `${rec.name} (this node's own Bosun stack) was not confirmed within an hour. Check it under Stacks.`);
    return;
  }
  const loaded = await stackManager();
  if (!loaded?.spec.stacks) return;

  if (rec.phase === 'deploying') {
    const listed = await loadDataset(rec.serverId, loaded, loaded.spec.stacks.list, {}).catch(() => null);
    const row = (Array.isArray(listed?.data) ? listed!.data as Record<string, unknown>[] : []).find(x => x.name === rec.name);
    const managed = !!row && typeof row.source === 'string' && !!row.source && row.source !== 'external';
    if (!managed) return; // not yet: the next call looks again
    if (!(rec.detach && rec.portainer)) {
      if (await claim(key, raw, null)) await done(rec, true, `Imported ${rec.name} into Bosun`, `${rec.name} (this node's own Bosun stack) is now a Bosun stack and runs from Bosun's copy.`);
      return;
    }
    const next: SelfImport = { ...rec, phase: 'detaching', at: new Date().toISOString() };
    if (!(await claim(key, raw, next))) return;
    const auth = await asker(rec.user);
    if (!auth) {
      await claim(key, JSON.stringify(next), null);
      await done(rec, false, `Imported ${rec.name}; not detached`, `${rec.name} is now a Bosun stack, but ${rec.user.username} no longer has Full access, so it was not detached from Portainer.`);
      return;
    }
    // Portainer's delete stops this Bosun; the waiter brings it back and the restarted process reports below.
    const outcome = await detachStack(auth, rec.serverId, loaded, rec.name, rec.portainer, true);
    if (await claim(key, JSON.stringify(next), null)) {
      const failed = outcome.startsWith('Detaching from Portainer failed');
      await done(rec, !failed, failed ? `Imported ${rec.name}; detaching failed` : `Imported ${rec.name} and detached it`, `${rec.name} is now a Bosun stack. ${outcome}`);
    }
    return;
  }

  // phase 'detaching': this is the process the waiter started again after Portainer's delete.
  let still: boolean | null = null;
  try { still = (await listStacks(rec.serverId)).some(p => p.Id === rec.portainer?.id); } catch { still = null; }
  if (await claim(key, raw, null)) {
    if (still === false) await done(rec, true, `Imported ${rec.name} and detached it`, `${rec.name} is now a Bosun stack. It was removed from Portainer and started again from Bosun's copy.`);
    else await done(rec, false, `Imported ${rec.name}; detaching is unconfirmed`, `${rec.name} is now a Bosun stack, but ${still ? 'Portainer still lists it' : 'Portainer could not be asked'}. Detach it again on the import card if it is still listed.`);
  }
}
