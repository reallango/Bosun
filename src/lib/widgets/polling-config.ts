import { rqlite } from '@/lib/db/rqlite-client';
import { resolveWidgetDefinition } from '@/components/widgets/registry-loader';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Ensure a `widget_polling_config` row exists for a widget.
 *
 * The poller LEFT JOINs this table and the data route's cache-first read is only
 * meaningful when the poller has a config to poll with; without a row the widget
 * silently falls back to a live SSH call on every dashboard load. Seeding the
 * row from the widget's definition (or its type defaults) on create keeps
 * caching on by default while still letting the user disable it per widget.
 */
export async function ensurePollingConfig(widget: {
  id: string;
  widget_type: string;
  server_id: string;
}): Promise<void> {
  const existing = await rqlite.query('SELECT id FROM widget_polling_config WHERE widget_id = ?', [widget.id]);
  if (existing.values?.length) return;

  const def = await resolveWidgetDefinition(widget.widget_type);
  const useDatabase = def ? def.useDatabase !== false : true;

  await rqlite.execute(
    `INSERT INTO widget_polling_config (id, widget_id, widget_type, server_id, poll_interval_sec, ttl_sec, storage_mode, enabled, use_database)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      widget.id,
      widget.widget_type,
      widget.server_id,
      def?.defaultPollInterval ?? 30,
      def?.defaultTTL ?? 1800,
      def?.storageMode ?? 'latest_ttl',
      useDatabase ? 1 : 0,
      useDatabase ? 1 : 0,
    ]
  );
}

/** Widget types the poller deliberately never caches (matching its SQL filter). */
const NON_POLLABLE_TYPES = ['ssh_terminal', 'server_summary'];

/**
 * Backfill a `widget_polling_config` row for every existing pollable widget that
 * lacks one.
 *
 * `ensurePollingConfig` only runs on widget create, so widgets created before it
 * (or whose seed failed) are never polled and pay a live SSH round-trip on every
 * dashboard load. This sweep runs once at startup so the cache-first read is
 * actually backed by a poller. Idempotent: widgets that already have a row
 * (per-widget or legacy type+server) are skipped.
 */
export async function backfillPollingConfigs(): Promise<number> {
  const res = await rqlite.query(
    `SELECT w.id, w.widget_type, w.server_id
       FROM widgets w
       LEFT JOIN widget_polling_config wpc ON wpc.widget_id = w.id
       LEFT JOIN widget_polling_config legacy
         ON legacy.widget_id IS NULL AND legacy.widget_type = w.widget_type AND legacy.server_id = w.server_id
      WHERE w.widget_type NOT IN (?, ?)
        AND wpc.id IS NULL AND legacy.id IS NULL`,
    NON_POLLABLE_TYPES
  );

  let created = 0;
  for (const row of res.values || []) {
    const [id, widgetType, serverId] = row as [string, string, string];
    try {
      await ensurePollingConfig({ id, widget_type: widgetType, server_id: serverId });
      created++;
    } catch (err) {
      console.error(`Backfill polling config failed for widget ${id}:`, err);
    }
  }
  return created;
}
