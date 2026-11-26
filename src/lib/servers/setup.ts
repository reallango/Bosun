/**
 * "Set up this server": the software installed widgets can put on a host (each widget's `setup` declaration: a detect
 * dataset and an install action), with what the host has now. Core only lists and runs what widgets declare.
 */
import type { TokenPayload } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { hasPermission } from '@/lib/permissions/authorize';
import { loadDataset, loadWidgetSpec } from '@/lib/widgets/runtime/execute';

export interface SetupItem {
  widget_type: string;
  label: string;
  description: string | null;
  /** null when the detection failed (see error). */
  installed: boolean | null;
  running: boolean | null;
  version: string | null;
  supported: boolean | null;
  system: string | null;
  note: string | null;
  error: string | null;
  install: { action_id: string; label: string; allowed: boolean; confirm: { title?: string; text?: string } | null };
}

const s = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const b = (v: unknown) => (typeof v === 'boolean' ? v : null);

/** Every installed widget's setup for this server that the caller may see (the detect dataset's permission). */
export async function listSetups(auth: TokenPayload, serverId: string): Promise<SetupItem[]> {
  const r = await rqlite.query('SELECT type FROM custom_widgets WHERE enabled = 1 AND spec IS NOT NULL ORDER BY type');
  const out: SetupItem[] = [];
  for (const [type] of r.values || []) {
    const loaded = await loadWidgetSpec(String(type));
    const setup = loaded?.spec.setup;
    if (!loaded || !setup) continue;
    const ds = loaded.spec.datasets?.[setup.detect];
    if (!ds || !(await hasPermission(auth, ds.permission, serverId))) continue;
    const action = loaded.spec.actions.find(a => a.id === setup.install);
    if (!action) continue;
    let state: Record<string, unknown> = {};
    let error: string | null = null;
    try {
      const d = (await loadDataset(serverId, loaded, setup.detect, {})).data;
      if (d && typeof d === 'object' && !Array.isArray(d)) state = d as Record<string, unknown>;
      else error = 'The detection answered something unexpected';
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    }
    const confirm = action.confirm && typeof action.confirm === 'object' ? action.confirm as { title?: string; text?: string } : null;
    out.push({
      widget_type: loaded.type, label: setup.label, description: setup.description ?? null,
      installed: b(state.installed), running: b(state.running), version: s(state.version, 60), supported: b(state.supported),
      system: s(state.system, 120), note: s(state.note, 300), error,
      install: { action_id: action.id, label: action.label, allowed: await hasPermission(auth, action.permission, serverId), confirm },
    });
  }
  return out;
}
