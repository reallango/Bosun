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
