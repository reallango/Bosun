# 1. OBJECTIVE

> **STATUS: IMPLEMENTED.** All steps below are complete. Verified with `tsc --noEmit`,
> `npm run lint`, `npm run build`, and an end-to-end run against a real rqlite v10.4.0
> node (migrations, health, settings PUT, all three export formats, JSON/SQLite import).
> The plan is retained as a record of the design.

Add a **Database Health & Settings** page with **export/import** of the database, and
extend the site's health checks. The page must:

1. Report database health, including whether the **correct migrations** have been applied.
2. Expose the editable `app_config` settings (currently seeded but unused by any UI/API).
3. Allow **exporting** the database to a portable backup file and **importing** it back.
4. Surface broader **site health checks** (app, database, websocket, poller, SSH fleet).

# 2. CONTEXT SUMMARY

- Stack: Next.js 14 (App Router) + TypeScript, Tailwind, shadcn-style UI primitives.
- Database: **rqlite** (SQLite over Raft), accessed via `src/lib/db/rqlite-client.ts`
  (`query`, `execute`, `executeBatch`, `getStatus`, `isReady`). No ORM.
- Migrations: `src/lib/db/migrations/index.ts` — a hard-coded registry `001`..`005`
  plus a `migrations` table (`id`, `name`, `applied_at`). `runMigrations()` runs at boot
  from `src/app/api/health/route.ts` via `initializeDatabase()`.
- Config store: `app_config` table (`key`, `value`, `description`, `updated_at`) with
  helpers `getConfig()` / `setConfig()`. **No API route and no UI currently read or write it.**
- Existing health: `src/app/api/health/route.ts` (unauthenticated, returns `{status,timestamp}`,
  also triggers DB init). `src/lib/health/checker.ts` polls the **SSH server fleet** only.
- `ws-server.js` already exposes a `/health` endpoint on port 3002; `poller.js` is a
  separate background process with no health endpoint.
- Auth: `requireAuth()` / `requireRole()` in `src/lib/auth/middleware.ts`; roles are
  `admin > operator > viewer`. API responses use `ok()` / `fail()` from `src/lib/api/response.ts`.
- Settings nav lives in `src/components/layout/Sidebar.tsx` (Servers, SSH Keys, Cluster,
  Alerts, Audit Log). There is no Database/Health entry yet.
- Note: `src/app/(dashboard)/settings/page.tsx` ("General Settings") has a **no-op
  `handleSave` stub** and read-only fields — a natural home for the editable settings.

## Known gaps this plan closes

- Migrations that **fail partway** are still recorded as applied (`runMigrations()` records
  the migration even when `failCount > 0`), and there is no way to detect the drift.
- No export/import path exists for backup, restore, or migrating between hosts.
- Health only covers the SSH fleet; the app/DB/ws/poller are not reported.

# 3. DESIGN DECISIONS (defaults chosen — see Section 6 to change)

| Decision | Default |
| --- | --- |
| Page route | `/settings/database` |
| Nav label | "Database" |
| API base | `/api/db/*` |
| Export formats | `json` (portable), `sqlite` (binary snapshot), `sql` (text dump) |
| Export options | Modal dialog: format, table scope, secrets, schema/version, large-table toggle |
| Import mode | **Merge** for JSON; **replace/restore** required for `sqlite`/`sql` |
| Secrets in export | **Redacted** by default in JSON; `sqlite`/`sql` are always full (cannot redact) |
| Versioning | Export carries `formatVersion` + `schemaVersion` (migration IDs) + `appVersion`; import blocks newer schema |
| Public health endpoint | Keep `/api/health` minimal (liveness only); detailed report is authenticated |
| Editable config keys | `app.*`, `ssh.*`, `alerts.*`, `cleanup.*`, `health.*` (server/SSH-key data is managed elsewhere) |

# 4. IMPLEMENTATION STEPS

## Step 1: Migration integrity helpers
- File: `src/lib/db/migrations/index.ts`
- Export the registry and expected IDs (`EXPECTED_MIGRATIONS = Object.keys(migrations)`).
- Export `getAppliedMigrations()` returning rows from the `migrations` table.
- Export `getMigrationStatus()` → `{ applied, expected, missing, pending }`.
- Fix the "record on partial failure" behaviour so a migration that fails is not silently
  marked applied (either roll back the record, or record a `failed` state + surface it).

## Step 2: Database health report
- New file: `src/lib/health/db-health.ts`
- `getDatabaseHealth()` returns:
  - `ready`: `rqlite.isReady()`
  - `leader` / `raft` summary from `rqlite.getStatus()`
  - `migrations`: from `getMigrationStatus()` (Step 1)
  - `tables`: expected vs. present (derive expected from migration statements)
  - `counts`: row counts per core table (servers, dashboards, widgets, ssh_keys, users, alerts, audit_log)
  - `configKeys`: missing seeded `app_config` keys
  - overall `status`: `ok | degraded | error`

## Step 3: Database export/import library
- New file: `src/lib/db/backup.ts`

### Export formats
| Format | How we produce it | Restore path | Notes |
| --- | --- | --- | --- |
| `json` | `SELECT *` per allow-listed table | `INSERT OR REPLACE` via `executeBatch` | Portable, inspectable, supports table scope + secret redaction |
| `sqlite` | `GET /db/backup` (hot SQLite snapshot) | `POST /db/load` (`application/octet-stream`) | rqlite's recommended backup; full fidelity; secrets cannot be redacted |
| `sql` | schema from `sqlite_master` + rows, emitted as `CREATE`/`INSERT` | `POST /db/load` (`text/plain`) | Text/diffable; generated in Node so no `sqlite3` binary is needed in the image |

Table allow-list (FK-safe order): ssh_keys → servers → dashboards → widgets → alert_rules →
notifications → notification_channels → app_config → users → sessions → audit_log →
widget_polling_config → widget_data_cache.

### Export options (drive the modal in Step 5)
- `format`: `json | sqlite | sql` (default `json`)
- `tables`: allow-list subset (JSON only)
- `includeSecrets`: redact vs. include encrypted values (JSON only; disabled for `sqlite`/`sql`)
- `excludeLarge`: skip `widget_data_cache` / `audit_log` (default on for JSON)
- `schemaVersion`: version tag recorded in `meta` (default = current)

### Secret redaction (JSON only)
- Default: redact `private_key_enc`, `passphrase_enc`, `password_hash`, `totp_secret`
  (placeholder + `redacted: true` marker).
- Opt-in: include the **encrypted** values as stored. These are encrypted with `MASTER_KEY`,
  so a restore only recovers secrets on a host using the **same `MASTER_KEY`**. Plaintext
  secrets are never emitted.

### Meta / versioning
`meta = { format, formatVersion, schemaVersion, appVersion, exportedAt, nodeId, migrationIds, includesSecrets, tables }`
- `formatVersion`: Bosun backup schema, starts at `1`.
- `schemaVersion`: highest applied migration ID at export time (e.g. `005`).
- `sqlite`/`sql` carry version info only via filename/header comment; JSON stores it in `meta`.

### Import
- Auto-detect format: JSON parse, `.sqlite` magic bytes (`SQLite format 3`), or SQL text.
- Validate `formatVersion` (reject newer) and `schemaVersion` vs. `EXPECTED_MIGRATIONS`:
  equal → proceed; older → proceed then run forward migrations; newer → block.
- `sqlite`/`sql` restore into a populated cluster is **undefined** per rqlite → require an
  explicit destructive "replace" confirmation.
- JSON import is FK-ordered and uses `INSERT OR REPLACE` (merge).

## Step 4: API routes (all admin-only unless noted)
- `src/app/api/db/health/route.ts` — GET → database health report (Step 2).
- `src/app/api/db/settings/route.ts` — GET list + PUT update editable `app_config` keys.
- `src/app/api/db/export/options/route.ts` — GET → available formats, table list, current schema version.
- `src/app/api/db/export/route.ts` — GET (query params from the modal) → file download
  (`Content-Disposition: attachment`, correct `Content-Type` per format).
- `src/app/api/db/import/route.ts` — POST (multipart) → auto-detect, validate version, apply,
  return per-table counts and the detected format.
- `src/app/api/system/health/route.ts` — GET → full site health (Step 6), authenticated.

## Step 5: Database settings UI
- New page: `src/app/(dashboard)/settings/database/page.tsx` with three cards:
  1. **Health** — status badge, migration table (applied/pending/missing), table row counts.
  2. **Settings** — editable inputs for the `app_config` keys (name, theme, timezone,
     refresh interval, ssh timeout, alerts toggle, cleanup retention).
  3. **Backup** — "Export" and "Import" buttons that open the options modals below.
- **Export modal** (`src/components/dialogs/DatabaseExportDialog.tsx`): format radio
  (JSON / SQLite snapshot / SQL dump), table scope checkboxes, "include encrypted secrets"
  toggle (JSON only — disabled with an explanatory note for the other formats), "exclude large
  tables" toggle, and a read-only schema/version line. Shows a secrets warning when enabled.
- **Import modal** (`src/components/dialogs/DatabaseImportDialog.tsx`): file picker with
  auto-detected format + version compatibility result, merge-vs-replace choice, and a
  destructive-action confirm when a full restore is selected.
- Reuse existing primitives (`Card`, `Table`, `button`, `input`, `label`) and match the
  existing dark-mode conventions (`bg-white dark:bg-gray-800`, etc.). Follow the existing
  dialog patterns in `src/components/dialogs/` (e.g. `DeleteConfirmDialog.tsx`).
- Add a **Database** link to the Settings nav in `src/components/layout/Sidebar.tsx`.

## Step 6: Broader site health checks
- New file: `src/lib/health/system-health.ts` — aggregates:
  - **App**: build/version, uptime, node version.
  - **Database**: reuse `getDatabaseHealth()`.
  - **WebSocket**: probe `http://localhost:${WS_PORT}/health` (already implemented).
  - **Poller**: add a `/health` endpoint to `poller.js` and a last-poll timestamp; probe it.
  - **SSH fleet**: count of online/offline servers from the `servers` table (reuse checker data).
- Surface the aggregate on the Database page (and optionally a small status indicator in `Header.tsx`).

# 5. TESTING AND VALIDATION

**Success criteria:**
1. `/settings/database` renders health, settings, and backup cards; nav link appears.
2. Health correctly reports **all migrations applied** on a fresh DB, and reports
   **missing/pending** when a `migrations` row is deleted or a new migration is unapplied.
3. Settings PUT persists to `app_config` and survives a reload.
4. Export modal produces all three formats; JSON downloads with redacted secrets by default
   and includes encrypted secrets when opted in; `sqlite`/`sql` downloads are valid and
   restorable.
5. JSON export→import round-trips without FK errors; a newer `schemaVersion` is rejected;
   `sqlite`/`sql` restore requires the destructive confirm.
6. `/api/system/health` returns per-component status; `/api/health` stays lightweight.
7. `npm run lint` and `npm run build` pass.

# 6. RISKS / OPEN QUESTIONS

- **Restore semantics differ by format**: JSON merges; `sqlite`/`sql` are full replace.
  rqlite documents loading a dump/snapshot into a populated cluster as undefined behaviour,
  so those paths are gated behind an explicit confirmation.
- **Secrets**: default redaction means a re-imported JSON backup loses SSH keys / password
  hashes unless secrets are included. Even when included, they are `MASTER_KEY`-encrypted, so
  they only restore on a host with the same `MASTER_KEY`; plaintext is never emitted.
- **Binary/text exports are unredactable**: the secrets toggle is JSON-only.
- **`executeBatch` size**: large exports (e.g. `widget_data_cache`, `audit_log`) should be
  chunked and/or excluded by default to avoid huge payloads.
- **Schema drift**: if a migration half-applied historically, the migration is recorded as
  applied today; Step 1's fix only helps going forward.
