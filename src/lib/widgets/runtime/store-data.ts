/**
 * An action that stores its output as the widget's data (`stores: "data"`, for example "check now"): the output is read
 * the way the poller reads the data script of the widget and written to the same snapshot section, so the widget shows
 * it at once and the background collection carries on from there.
 */
import { rqlite } from '@/lib/db/rqlite-client';
import type { DataSpec } from '@/lib/widgets/runtime/spec';
import { parseOutput, shapeData } from '@/lib/widgets/runtime/data';

type Parse = (kind: unknown, text: string) => unknown;
type Shape = (spec: unknown, parsed: unknown) => unknown;

/**
 * The snapshot section a command-sourced widget's data lives in: one per widget type and server, or one per widget when
 * its arguments or interval come from the widget's own settings.
 */
export function dataSectionFor(type: string, ds: DataSpec, instanceId?: string): string {
  const perInstance = ds.source === 'command' && !!ds.script && !!(ds.cacheSecFrom || (ds.args && Object.keys(ds.args).length));
  return perInstance && instanceId ? `pkg:${type}#${instanceId}` : `pkg:${type}`;
}

/** Store the output of an action as the widget's data. Returns false when it cannot be read as the widget's data. */
export async function storeActionData(serverId: string, type: string, ds: DataSpec, instanceId: string | undefined, stdout: string): Promise<boolean> {
  if (ds.source !== 'command') return false;
  let data: unknown;
  try {
    data = (shapeData as Shape)(ds, (parseOutput as Parse)(ds.parse, stdout.slice(0, 256 * 1024)));
  } catch {
    return false;
  }
  await rqlite.execute(
    'INSERT INTO host_snapshots (server_id, section, data, data_hash, collected_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(server_id, section) DO UPDATE SET data = excluded.data, data_hash = excluded.data_hash, collected_at = excluded.collected_at',
    [serverId, dataSectionFor(type, ds, instanceId), JSON.stringify({ ok: true, data }), null, Date.now()]);
  return true;
}
