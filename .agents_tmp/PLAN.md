# 1. OBJECTIVE

Let the user add a **Windows** machine to Bosun and manage it through PowerShell remoting
("PSSession") for both the dashboard widgets and the interactive terminal, alongside the
existing Linux/SSH servers.

# 2. CONTEXT SUMMARY

Bosun is currently **SSH/Linux-only** end to end. Everything that talks to a server goes
through `ssh2`:

- Connection layer: `src/lib/ssh/connection-pool.ts` (`SSHConnectionPool`, `sshPool`) —
  `getConnection` / `executeCommand` (uses `client.exec`), keyed by `user@host:port`.
- Server model: `servers` table (`src/lib/db/migrations/index.ts` migration 001) with
  `hostname`, `ssh_port`, `ssh_user`, `ssh_key_id`, `os_type`, `os_version`, etc. Types in
  `src/types/server.ts` (`Server`) and `src/lib/db/schema.ts` (`DBServer`).
- Credentials: only SSH **private keys**, stored encrypted in `ssh_keys.private_key_enc`
  (`src/lib/crypto/keys.ts`, `MASTER_KEY`). There is **no password/credential storage**.
- Widget data: `src/app/api/widgets/[widgetId]/data/route.ts` inlines a big
  `switch (widget.widget_type)` of **bash** commands run via `pool.executeCommand`. It **reads**
  `widget_data_cache` first (keyed by `widget_type` + `server_id`) and only falls back to live
  SSH on a miss or `?force=true`.
- Terminal: `ws-server.js` connects with `ssh2`, calls `client.shell(...)` to open a PTY, and
  bridges it to the browser over `/ws/terminal`. It has its own rqlite query + decrypt logic.
- Background poller: `poller.js` is the **only writer** of `widget_data_cache`. It is a
  standalone CommonJS process with its own raw-text bash collectors and its own ssh2 connection
  cache, and it is **not started by any npm script** (`dev:all` runs only `next dev` +
  `ws-server.js`).
- Health: `src/lib/health/checker.ts` runs `echo test` over SSH to set `is_online`.
- Detect: `src/app/api/servers/[serverId]/detect/route.ts` runs `cat /etc/os-release`, `lscpu`,
  `uname`, etc.
- OS adapters (`src/lib/ssh/adapters/*`) exist but the widget route does **not** use them.
- Add-server UI: `src/app/(dashboard)/settings/servers/new/page.tsx`,
  `src/components/settings/ServerForm.tsx`, `EditServerModal.tsx`,
  `src/app/(dashboard)/settings/servers/[serverId]/page.tsx`.
- No `windows`/`powershell`/`winrm` references exist anywhere in `src`.

# 3. APPROACH OVERVIEW

**PowerShell remoting over SSH ("SSHTransport"), reusing the existing `ssh2` stack.**
On Windows, run PowerShell commands over the same SSH channel Bosun already uses:
non-interactive widgets execute `powershell -NoProfile -NonInteractive -Command "<cmd>"`, and
the terminal opens an interactive PowerShell PTY. This is how
`Enter-PSSession -HostName <host> -SSHTransport` works under the hood, and Windows 10 (1809+)
/ Server 2019+ ship OpenSSH server.

- Reuses the connection pool, terminal bridge, poller and health checker — only branching on a
  `platform` flag — instead of standing up a second transport.
- **Auth: existing SSH keys (public-key auth), per decision.** No new credential store; the
  Windows host must have the Bosun public key in
  `C:\ProgramData\ssh\administrators_authorized_keys` (see Step 8).
- **Widget scope (confirmed):** Windows v1 supports `server_summary`, `os_info`, `cpu_memory`,
  `disk_usage`, `network`, `system_services`, `custom_command`, `gpu_monitoring` and
  `ollama_status`. Unsupported on Windows in v1: `docker_containers`, `os_update_check`
  (graceful placeholder, not an error).
- **Data path — same as Linux:** Windows widgets are populated into `widget_data_cache` by
  `poller.js` (Step 7) and served from there by the widget data route, exactly like Linux. The
  route's live PowerShell branch (Step 4) only runs on a cache miss or `?force=true`, mirroring
  the Linux behaviour. The Linux collectors are also unified into a shared module (Step 8) so
  both platforms cache valid JSON from one implementation.
- **`portainer_link` is removed entirely** — it does not work today and is unused (Step 0).

# 4. IMPLEMENTATION STEPS

## Step 0: Remove the unused `portainer_link` widget
- **Goal:** delete a broken, unused widget end to end.
- **Method:** the widget is broken because there is **no `portainer_url` column** on `servers`
  (not in any migration or `DBServer`), so the data route's `SELECT portainer_url FROM servers`
  fails and the PATCH allow-list drops the field. Remove all references:
  - delete `src/components/widgets/portainer-link/` (both `index.tsx` and
    `PortainerLinkWidget.tsx`);
  - remove the `portainer_link` entry from `src/components/widgets/registry.ts`;
  - remove the `portainer_link` line from the `widgets` list in
    `src/components/dashboard/AddWidgetModal.tsx`;
  - remove the `PortainerLinkWidget` import and the `portainer_link` case from
    `src/components/dashboard/WidgetFrame.tsx`;
  - remove the `case 'portainer_link'` block (and its `SELECT portainer_url` query) from
    `src/app/api/widgets/[widgetId]/data/route.ts`;
  - remove the `portainer_url` field from `src/types/server.ts`;
  - remove the Portainer URL input + `portainer_url` form state from
    `src/app/(dashboard)/settings/servers/[serverId]/page.tsx`.
  - Note: any pre-existing `portainer_link` widgets will render as "Unknown widget"; they can
    be deleted by the user. No DB migration is needed (no column exists).
- **Reference:** `src/components/widgets/portainer-link/`, `src/components/widgets/registry.ts`,
  `src/components/dashboard/AddWidgetModal.tsx`, `src/components/dashboard/WidgetFrame.tsx`,
  `src/app/api/widgets/[widgetId]/data/route.ts`, `src/types/server.ts`,
  `src/app/(dashboard)/settings/servers/[serverId]/page.tsx`.

## Step 1: Schema — mark a server as Windows
- **Goal:** persist the platform so every code path can branch on it.
- **Method:** add migration `007` to `src/lib/db/migrations/index.ts`:
  `ALTER TABLE servers ADD COLUMN platform TEXT DEFAULT 'linux'` (values `linux` | `windows`),
  registered in the `migrations` map. Update `DBServer` (`src/lib/db/schema.ts`) and `Server`
  (`src/types/server.ts`) with `platform`.
- **Reference:** `src/lib/db/migrations/index.ts`, `src/lib/db/schema.ts`,
  `src/types/server.ts`.

## Step 2: Platform + PowerShell execution helpers
- **Goal:** one place that turns "run this on server X" into the right transport.
- **Method:** new module `src/lib/ssh/platform.ts`:
  - `isWindows(server): boolean` from `server.platform === 'windows'`.
  - `powershellCommand(script: string): string` — wraps a script as
    `powershell -NoProfile -NonInteractive -Command "<script>"` with correct quoting/escaping
    (single-quote the outer arg, escape embedded `"`).
  - `runOnServer(pool, server, credential, command)` — for Linux runs `command`; for Windows
    runs `powershellCommand(command)`. This is the single branch point used by the routes.
- **Reference:** `src/lib/ssh/connection-pool.ts`.

## Step 3: Windows terminal in `ws-server.js`
- **Goal:** the existing terminal widget gives an interactive PowerShell session on Windows.
- **Method:** in `connectToServer`, also `SELECT platform` from `servers`. When
  `platform === 'windows'`, open the PTY with
  `client.exec('powershell -NoLogo -NoProfile', { pty: { term: 'xterm-256color', cols, rows } }, cb)`
  instead of `client.shell(...)`, and adjust the banner text ("Connected via PowerShell").
  Reuse the existing stream/reattach/buffer logic unchanged (it is transport-agnostic once a
  stream exists). Resize handling already calls `stream.setWindow(...)`, which works the same.
- **Reference:** `ws-server.js` (`connectToServer`, new-session `client.shell` block).

## Step 4: Windows widget data
- **Goal:** widgets render meaningful data for Windows servers.
- **Method:** in `src/app/api/widgets/[widgetId]/data/route.ts`, after loading `srv`, branch on
  `srv.platform === 'windows'` and route each widget type to a PowerShell implementation that
  returns the **same JSON shape** the existing React widgets expect. Put the PowerShell
  collectors in a new shared `src/lib/windows/collectors.js`
  (`getWindowsWidgetData(type, runPS, cfg)`).
  - Supported (v1): `server_summary`, `os_info`, `cpu_memory`, `disk_usage`, `network`,
    `system_services`, `custom_command`, `gpu_monitoring`, `ollama_status`.
  - Mapping sketch: `os_info` → `Get-CimInstance Win32_OperatingSystem` + `$PSVersionTable`;
    `cpu_memory` → `Get-CimInstance Win32_Processor` / `Win32_OperatingSystem`
    (`TotalVisibleMemorySize`/`FreePhysicalMemory`) + `Get-Counter '\Processor(_Total)\% Processor Time'`;
    `disk_usage` → `Get-CimInstance Win32_LogicalDisk`; `network` → `Get-NetIPAddress` /
    `Get-NetAdapter`; `system_services` → `Get-Service`.
  - `gpu_monitoring`: run `nvidia-smi --query-gpu=... --format=csv,noheader` exactly as the
    Linux path does (`nvidia-smi.exe` ships in `C:\Windows\System32` and `%ProgramFiles%\NVIDIA
    Corporation\NVSMI`); parse the first line into the same single-GPU object
    `{ name, vram_total_mb, vram_used_mb, utilization_percent, temperature_c, power_watts }`.
  - `ollama_status`: `Invoke-RestMethod http://localhost:11434/api/tags` → the same
    `{ status, models[] }` shape as the Linux `curl` path (models from `tags.models`).
  - Unsupported on Windows in v1 (`docker_containers`, `os_update_check`) return the existing
    graceful placeholder (`{ source: 'placeholder' }` or an empty list) rather than an error.
  - **Shared module:** put the collectors in a plain CommonJS file
    `src/lib/windows/collectors.js` with **no imports** (each collector takes a `runPS` command
    function), so both this TS route (`import { getWindowsWidgetData } from
    '@/lib/windows/collectors'`) and `poller.js` (`require('./src/lib/windows/collectors')`) use
    one implementation. Keep the PowerShell escaping helper there too, so the shared paths use
    exactly one quoter. `tsconfig.json` already has `allowJs: true`.
  - **Cache-first (unchanged):** the route still reads `widget_data_cache` first and only falls
    back to this live PowerShell branch on a miss or `?force=true` — same as Linux. The
    `server_summary` early-return is unchanged.
- **Reference:** `src/app/api/widgets/[widgetId]/data/route.ts`,
  `src/lib/windows/collectors.js`,
  `src/components/widgets/gpu-monitoring/GPUMonitoringWidget.tsx`,
  `src/components/widgets/ollama-status/OllamaStatusWidget.tsx`.

## Step 5: Windows OS detect
- **Goal:** "Detect OS" works on Windows and sets `platform`/`os_type`.
- **Method:** in `src/app/api/servers/[serverId]/detect/route.ts`, branch on platform: for
  Windows run PowerShell (`Get-CimInstance Win32_OperatingSystem` → Caption/Version,
  `Get-CimInstance Win32_Processor` → Name/NumberOfCores, memory totals) and store
  `os_type = 'windows'`.
- **Reference:** `src/app/api/servers/[serverId]/detect/route.ts`.

## Step 6: Add / Edit server UI for platform
- **Goal:** the user can create a Windows server from the UI.
- **Method:** add a **Platform** selector (Linux / Windows) to
  `src/app/(dashboard)/settings/servers/new/page.tsx`, `src/components/settings/ServerForm.tsx`,
  `EditServerModal.tsx`, and the edit page
  `src/app/(dashboard)/settings/servers/[serverId]/page.tsx`. Send `platform` in the create
  (`POST /api/servers`) and update (`PATCH /api/servers/[serverId]`) payloads; add `platform`
  to the PATCH allow-list in `src/app/api/servers/[serverId]/route.ts`. For Windows, label the
  existing SSH-key field clearly (the key goes in `administrators_authorized_keys`).
- **Reference:** `src/app/(dashboard)/settings/servers/new/page.tsx`,
  `src/components/settings/ServerForm.tsx`, `src/components/settings/EditServerModal.tsx`,
  `src/app/api/servers/route.ts`, `src/app/api/servers/[serverId]/route.ts`.

## Step 7: Health check + poller — cache Windows widget data
- **Goal:** Windows widgets are polled and cached in `widget_data_cache` just like Linux, so
  dashboards read from the DB rather than always hitting the host live.
- **Method:**
  - `src/lib/health/checker.ts`: select `platform` and use a platform-appropriate liveness
    command (`echo test` works on Windows OpenSSH; a PowerShell command is more deterministic).
  - `poller.js`: join `servers` to select `platform` (and the connection fields) per widget. In
    the poll loop, when the widget's server is Windows, run the **shared Windows collectors**
    (`require('./src/lib/windows/collectors')`) over a `runPS` helper that executes
    `powershell -NoProfile -NonInteractive -Command "<script>"` on the cached connection, instead
    of the bash collectors. The existing cache-write, `change_only` hash comparison,
    `last_polled_at` update and TTL/`expires_at` logic are unchanged, so Windows data lands in
    `widget_data_cache` with the same lifecycle as Linux.
  - Windows collector set = the same v1 widget set as Step 4 (`server_summary`, `os_info`,
    `cpu_memory`, `disk_usage`, `network`, `system_services`). `gpu_monitoring`, `ollama_status`
    and `custom_command` are not polled on either platform, so Windows serves those live via the
    route's Step 4 branch — identical to Linux.
  - `poller.js` is not started by any npm script (`dev:all` runs only `next dev` + `ws-server.js`);
    this step does not change how it is launched, only what it does for Windows rows.
- **Reference:** `src/lib/health/checker.ts`, `poller.js`, `src/lib/linux/collectors.js`,
  `src/lib/windows/collectors.js`.

## Step 8: Fix the Linux poller collectors to emit JSON (make Linux caching work)
- **Goal:** cached Linux widget data is **valid JSON** and byte-identical in shape to the
  route's live output, so DB caching actually works for Linux. Today `poller.js` stores raw text
  (e.g. `server_summary` returns a shell string, `cpu_memory` returns raw `/proc/meminfo`) while
  the route `JSON.parse`s cached rows — so cached Linux data throws and falls back to a
  placeholder.
- **Method:** remove the duplicated Linux command+parse logic by extracting it once.
  - Create `src/lib/linux/collectors.js` — dependency-free **CommonJS** (same constraints as the
    Windows module), exporting `getLinuxWidgetData(type, run, cfg)`, where `run` is the existing
    command runner. It returns **exactly** the JSON the React widgets consume:
    - `server_summary` → `{ is_online, hostname, os_type, os_version, name }`
    - `os_info` → `{ name, version, codename, prettyName, kernel, architecture, hostname, uptime, uptimeSeconds }`
    - `cpu_memory` → `{ cpu: { model, cores, threads, usagePercent, loadAvg1, loadAvg5, loadAvg15, temperature }, memory: { totalMB, usedMB, freeMB, availableMB, usagePercent, swapTotalMB, swapUsedMB } }`
    - `disk_usage` → `[{ filesystem, fsType, sizeMB, usedMB, availableMB, usagePercent, mountPoint }]`
    - `network` → `[{ name, state, mtu, macAddress, ipv4[], ipv6[] }]`
    - `system_services` → `[{ name, status, description, enabled }]`
    - `custom_command` → `{ output, exitCode }`
    - `gpu_monitoring` → `{ name, vram_total_mb, vram_used_mb, utilization_percent, temperature_c, power_watts }`
    - `ollama_status` → `{ status, models[] }`
    - `docker_containers` → `[{ id, name, image, status, state, ports }]`
    - `os_update_check` → `{ updatesAvailable, packages[], lastCheck }`
    - Copy the field names verbatim from the route's current `switch` so the widgets keep
      working unchanged.
  - **Route:** replace the inline `switch (widget.widget_type)` Linux branches with a delegation
    to `getLinuxWidgetData(type, run, cfg)`, and the Windows branch with
    `getWindowsWidgetData(...)`. The cache read, `server_summary` early-return and error handling
    stay as they are.
  - **`poller.js`:** delete the raw-text `collectors` object and call
    `getLinuxWidgetData`/`getWindowsWidgetData` for the polled types, so the poller caches the
    same JSON the route serves. The `servers` JOIN (Step 7) must also select the fields
    `server_summary` needs (`name`, `hostname`, `os_type`, `os_version`, `is_online`).
  - This de-duplicates Linux logic the same way as Windows and prevents the two paths from
    drifting again.
- **Reference:** `poller.js`, `src/lib/linux/collectors.js`,
  `src/app/api/widgets/[widgetId]/data/route.ts`.

## Step 9: Prerequisites documentation
- **Goal:** the user knows what to configure on the Windows host.
- **Method:** add a short section to `README.md`: install/enable OpenSSH Server
  (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`), start `sshd`, place the
  Bosun public key in `C:\ProgramData\ssh\administrators_authorized_keys` with the correct ACLs
  (`icacls ... /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`), and optionally set
  the default shell to PowerShell
  (`New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force`).
- **Reference:** `README.md`.

## Step 10: Verify build and types
- **Goal:** no regressions.
- **Method:** run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.

# 5. TESTING AND VALIDATION

**Success criteria:**

1. `portainer_link` is gone: it no longer appears in the Add Widget list or the registry, the
   `portainer-link` component files are deleted, and no `portainer_url` references remain.
2. A Windows host can be added via the UI with `platform = windows` (using an existing SSH key)
   and appears in `/settings/servers` like any other server.
3. "Test Connection" and "Detect OS" succeed against the Windows host and populate
   `os_type = 'windows'` (plus version/CPU/RAM).
4. The terminal widget on a Windows server opens an **interactive PowerShell** session
   (prompt, command execution, resize, reconnect/reattach all work).
5. The v1 widget set renders real data on the Windows host with the same JSON shapes as their
   Linux counterparts — including `gpu_monitoring` (via `nvidia-smi`) and `ollama_status` (via
   the Ollama HTTP API). `docker_containers` and `os_update_check` show the graceful
   placeholder, not an error.
6. Windows widgets are served from `widget_data_cache`: after the poller runs a cycle, the
   route returns cached rows (no live SSH) for the polled types, and `?force=true` refreshes
   live — the same behaviour as Linux. `gpu_monitoring`/`ollama_status`/`custom_command`
   remain live-only on both platforms.
7. **Linux caching is fixed:** after the poller runs a cycle, cached Linux rows are valid JSON
   and render correctly (no placeholder fallback), and the cached shape matches the route's live
   output for the same widget type.
8. Linux live behaviour is unchanged when the cache is empty or `?force=true` is used (the route
   still returns the same JSON it did before).
9. `npx tsc --noEmit`, `npm run lint`, and `npm run build` all pass.

# 6. RISKS / NOTES

- **Prerequisite on the host:** OpenSSH server must be installed and the key placed in
  `administrators_authorized_keys` on the Windows machine; Bosun cannot bootstrap this the way
  it does for Linux (`src/app/api/servers/provision/route.ts` is Linux-only and stays so).
- **Escaping:** PowerShell quoting through `exec` is error-prone; the helper in Step 2 must be
  covered by tests/spot-checks to avoid command-injection and breakage.
- **GPU/ollama variance:** `gpu_monitoring` needs `nvidia-smi` present on the host (absent →
  the widget's existing "No GPU" fallback); `ollama_status` needs Ollama listening on
  `localhost:11434` on the host.
- **Shared module / runtime:** `poller.js` is CommonJS at the repo root while the widget route
  is TypeScript, so both collector modules must stay dependency-free CommonJS files (no
  `import`), with the command runner injected by each caller. `tsconfig.json` has `allowJs: true`,
  so the route can import them via the `@/` alias.
- **Linux caching fix is a behaviour change (in scope, per request):** previously the poller's
  Linux collectors stored raw text and the route could not parse it; after Step 8 the poller
  stores JSON, so Linux dashboards will start serving cached rows. Verify the cached JSON matches
  the widgets' expected shapes (especially `cpu_memory`, `disk_usage`, `network`,
  `system_services`) so nothing regresses, and confirm `change_only` types (`os_info`,
  `system_services`, `docker_containers`, `ollama_status`) hash-compare correctly.
- **Poller not auto-started:** no npm script launches `poller.js`, so caching (Linux or Windows)
  only happens while the poller process is running; otherwise widgets are served live by the
  route, exactly as before.
- **Existing portainer widgets:** any already-created `portainer_link` widgets become "Unknown
  widget" and must be removed by the user; no data migration is performed.
