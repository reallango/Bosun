# Plan: self-contained widget packages

Status: **in progress on `dev`. Phases 0 (spec v2), 1 (file store and materialiser), 2 (scripts runner, probes, lookups), 3 (jobs) and 4 (conditions, variants, UI blocks) are done and verified; phase 5 (port Ollama, OS Update Check and Custom Command) is done for Linux and Docker, its Windows live test is open; phase 8 (Docker package) is next.** Written on the `dev` branch so the work can be picked up later by anyone (or any
session). Phases marked "done" are built, tested and pushed to `dev`.

## 1. The rule

> Nothing in the main Bosun code may exist for only one widget. Everything a widget needs ships inside its package,
> so that a user can create their own widget without changing Bosun's code. Core contains only widget-agnostic
> endpoints and runtimes.

Cluster rule: **the database is the only synchronisation between nodes.** A package (manifest, scripts, files) is
stored in the database. Each node writes the files to a folder on its own disk when a package is added or changed,
so no other file-sync mechanism is needed.

Test of success: delete a widget's package and Bosun's source tree still contains no trace of that widget (no
names, no permission ids, no routes, no collector code, no components), and a brand-new widget of similar
complexity can be written as a package alone.

## 2. Where we are (done, on `dev`)

- Packages exist: manifest schema 1, install from GitHub or zip, permissions, declarative spec (data from a snapshot
  section or a command, list/table/text/fields/chart views, command and terminal actions, per-instance settings),
  poller-collected command data, tracked metrics with per-metric retention, OpenAPI generated from installed packages.
- Bundled ("preinstalled") packages: `widgets/bundled.json` lists packages installed on start and upgraded when the
  image carries a newer version; removed ones stay removed; GitHub/zip packages are never touched.
- Every widget except the SSH Terminal is a package: `docker`, `disk_usage`, `system_services`, `network`, `os_info`,
  `cpu_memory`, `gpu_monitoring`, `server_summary`, `metrics_chart`, `ollama`, `updates`, `commands`.
- Pure data widgets (disk, network, services, os info, cpu/memory, gpu, server summary, metrics history, docker list)
  are genuinely declarative and need nothing in core except the generic runtime.
- **Not compliant with the rule:** `ollama` (install/update/control/settings, model pull/delete), `updates` (OS update
  check and install) and `commands` (Custom Command) keep their logic and views in core; the Docker package depends on
  core routes and a core snapshot section. See section 3.
- Ollama as built today (reference for the port, all tested live): detection of service (nssm/Windows service),
  systemd unit, Docker container; start/stop/restart; startup method; restart policy; update to the latest release
  (GitHub release lookup, SHA-256 check); install (Windows service via nssm obtained with winget, with winget health
  check and repair; Linux Docker container by default, host install via the official script); reachable from the
  network by default (firewall rule on Windows); settings `OLLAMA_CONTEXT_LENGTH` and `OLLAMA_MAX_LOADED_MODELS`
  (nssm AppEnvironmentExtra, systemd drop-in, container recreate); collapsible "Installation" section with an
  "Update available" badge. The behaviour and the scripts are the specification for the port; keep them.

## 3. Inventory: widget-specific code in core today

Everything below must leave core (moved into the owning package or replaced by a generic feature).

| Area | Files (today) | Becomes |
| --- | --- | --- |
| Ollama server logic | `src/lib/ollama/*` (`manage.ts`, `scripts.ts`, `settings.ts`, `actions.ts`) | package scripts + generic job/state runtime |
| Ollama routes | `src/app/api/servers/[serverId]/ollama/{route,models,pull,service}/route.ts` | generic widget action/job/data routes |
| Ollama detection | probe + parser in `src/lib/collect/linux.js`, `windows.js`, `ollama-install.js`; `capabilities.ollama` in `store.js`; `ollama` in `stats/page.tsx` | package `state` probe |
| Ollama views | `src/components/widgets/ollama-status/*`, entry in `custom-registry.tsx` | declarative layout view in the package |
| Ollama bookkeeping | `AuditActions.OLLAMA_*` (`audit/logger.ts`), seeded `custom-ollama-status` row (migration v2), label map in `metrics/query.ts`, `snapshot-data.ts` cases, `system-packages.ts` | generic audit action, DB-defined metric labels, removal |
| OS update check | `src/components/widgets/os-update-check/*`, update logic in `api/widgets/[widgetId]/data/route.ts` (GET force=updates, POST install/status), poller `updates` tier and `checkWindowsUpdates`, `servers.updates_requested_at`, `src/lib/updates/*` | package state probe (own tier) + install job |
| Custom Command | `src/components/widgets/custom-command/*`, `custom_command` branch of the data route, `src/lib/widgets/custom-command.ts`, `mayChangeCommand` rule in the widget settings route | generic command data source reading instance settings + generic "settings field needs permission" rule |
| Docker | `/api/servers/[serverId]/containers/**`, `docker.*` permission checks in the terminal route and `openapi.ts`, the `docker` snapshot section and `docker` probe, `docker.running` metric in collectors | package actions (container actions, logs, terminal) and package state probe |
| Permissions | widget permissions are already in manifests; the permission catalog test reads `widgets/*/manifest.json` | keep, but test must not need widget folders |
| Compiled-in widget table | `customWidgetComponents`, `WIDGET_SECTIONS`, `widgetDataFromSnapshots` cases, `SNAPSHOT_SECTIONS` names | removed once nothing needs them |
| Shell-account / terminal | SSH Terminal widget, `/ws/api-terminal` container target | SSH Terminal stays a system widget (agreed); the container target becomes a generic terminal action |

Wake-on-LAN detects which server hosts the Bosun container. It is a core feature, not a widget, so it keeps its own
direct check (`docker inspect` over SSH); it must stop reading the `docker` snapshot section.

## 4. Decisions

### 4.1 Execution model — **DECIDED by the owner: declarative spec plus host scripts**

Chosen, and the basis of the rest of this plan: **declarative spec plus host scripts.** A package is data: a richer
spec plus script files that run on the managed host. No package code runs inside the Bosun process or the browser.
Everything a package can do to a server is a reviewed host command.

Alternative: packages ship code (server modules in a sandbox, prebuilt UI bundles loaded by the browser). More
flexible, but a package would then run with access to the user's session and Bosun's data, which needs real
sandboxing, signing and a much heavier install review. If a widget turns out to be impossible to express
declaratively, add this later as an opt-in tier (bundled or signed packages only) on top of the same file
materialisation (section 5.1). The owner chose the declarative option over the code option and over
"declarative first, code later"; do not build a code tier unless the owner asks for it again.

### 4.1a Scope — **DECIDED by the owner: all three widgets at once**

The generic runtime is designed against Ollama, OS Update Check and Custom Command together, so it is general from the
start and not shaped by one widget. Phases 5 to 7 below are therefore one combined "port the three widgets" step:
write the three package v2 manifests and scripts first (on paper, as the requirements for phases 1 to 4), build the
runtime until all three work, then delete the three widgets' code from core in one clean-up. The Docker completion
(phase 8) follows. Testing is still per widget (section 8), but nothing ships to a release until all three are done.

### 4.2 Decisions already made

- SSH Terminal remains a system widget for now.
- Permission ids, widget types and dashboards must keep working through the migration (no regrouping, no data loss).
- Bundled packages stay installed by default, removable, upgradable (see section 2).
- Windows test host and Docker test containers are used for verification (section 8).

## 5. Generic features core needs

Each item is widget-agnostic and is justified by a concrete need of the ported widgets.

### 5.1 Package file store and per-node materialisation

- Store every package file in the database (`widget_packages.files`; add a content hash per file and a package
  `content_hash`). Raise the limits (today 256 KB per file, 1 MB total, 40 files) to fit real scripts and assets, for
  example 2 MB per file and 8 MB per package, still reviewed at install.
- On start, and whenever a package changes, every node writes the package to `<data dir>/widgets/<id>/<version>/`
  (temp directory, hash check, atomic rename, remove old versions). Change detection through the database: nodes
  compare `content_hash` (poll every few seconds or on a cluster event). A node that is behind reads straight from the
  database, so a partitioned or new node never serves stale files.
- The materialised folder is read-only for everything except the materialiser, path-traversal safe, and the single
  place a future code tier would load from.
- Tests: materialiser unit tests (atomicity, hash mismatch, upgrade, removal, traversal), a two-node cluster test
  (install on node A, files appear on node B without any other sync).

### 5.2 Host scripts

- `spec.scripts`: named scripts mapped to package files per platform (`windows/*.ps1`, `linux/*.sh`), with a declared
  parameter list (names, types, patterns, ranges, defaults).
- Parameters are passed as data, never pasted into the script text: a JSON blob in an environment variable (or a
  `param` block on Windows) that the script reads. This replaces today's string-building and quoting helpers.
- Output protocol (generic): `[step] text` progress lines, `PROGRESS done/total` for percentages, `DONE <text>` on
  success, `ERROR: <text>` on failure, exit code as usual. Core shows steps and percentages and never needs to know
  what they mean.
- Runs as the service account or the non-admin account, as the script declares; the install review shows every
  script's name, account and hash (and offers to view the text).

### 5.3 State detection ("probes")

- `spec.state`: one or more probe scripts per platform plus a parser (key=value lines into typed fields, optional
  derived fields) run by the poller on a tier of the package's choosing (period, optional initial delay) and stored
  as the snapshot section `pkg:<type>:state`. This replaces every widget-specific addition to the collectors
  (`ollama`, `docker`, `updates` probes and their parsers).
- The existing generic `metrics` support records numbers from a state object; the Ollama `ollama.loaded` and Docker
  `docker.running` metrics become package metrics.
- A probe runs for a server only when that server has an instance of the widget (as command data does today), except
  where the package says it must run everywhere (Wake-on-LAN must not depend on one).

### 5.4 Lookups (external data)

- `spec.lookups`: HTTP GET of a URL template, JSON path extraction, cache TTL, performed by the web process.
- The manifest declares the hosts it may contact (`network: ["api.github.com"]`); the install review shows them and
  the runtime refuses anything else (no redirects off the list, size and time limits).
- Used for: latest Ollama release; later anything similar. Results are available to `when` expressions and templates.

### 5.5 Jobs

- `action.job: true`: the action runs asynchronously, with a per-server, per-widget job record (`package_jobs` table so
  that it survives a restart and is visible on every node), live steps and progress from the output protocol, cancel
  support, timeouts, one job at a time per widget instance, and an audit entry.
- Generic routes: start through the existing widget-action endpoint (answers 202), `GET .../widget-jobs/:type` for
  status. Replaces the Ollama pull and install/update job code and the OS update install code.

### 5.6 Conditions and variants

- Extend `Cond` into an expression: `all`, `any`, `not`, comparisons (`gt`, `lt`, `gte`, `lte`), paths into state,
  settings and lookup results, and version comparison (`newerThan`). Keep the existing simple form working.
- Actions may have variants selected by `when` (for example start/stop differ for a service, a container, a unit);
  each variant names its script. One logical action id for the API ("restart") regardless of the install kind.

### 5.7 UI building blocks (declarative views)

New view elements, all rendered by the existing declarative renderer, all escaped text only:

- `layout` with child blocks; `section` (collapsible, `defaultOpen`, header badges with conditions and colours);
  `kv` (labelled values); `badge`; `buttons` row bound to actions; `select` bound to an action with the current value
  taken from state; `form` / `input` (number, text, select) with validation and an Apply action; `jobProgress`;
  `notice` (info/warning, conditional); existing list/table/fields/chart as blocks.
- Confirmation dialogs per action (exists) with conditional text.
- Result: the Ollama widget (model list, pull form with progress, collapsible Installation section with the update
  badge, settings form) is expressible as one `layout`.

### 5.8 Generic plumbing that goes with it

- One generic audit action (`widget.action`) with the package, widget, action and parameters in the details.
- Permission catalog and OpenAPI come from manifests only (already true for OpenAPI); remove widget ids from core
  tests and the catalog comments.
- Instance-setting fields can require a permission to change (`requires_permission` on a `config_schema` field),
  replacing the Custom Command role check.
- Metric labels and units come from package metric definitions (exists); remove the hard-coded label map.
- Spec `version: 2` for the new elements; version 1 specs keep validating and rendering unchanged.

## 6. Phases

Each phase ends with a green build (`npx vitest run`, `tsc`, Docker build), a commit on `dev`, and, where it touches
hosts, the live tests in section 8. Do not push to `main` until the owner has tested everything.

0. **Confirm the decisions** (4.1), write the spec v2 schema and validators (types, errors) and the generic route
   contracts. Unit tests first.
1. **File store and materialiser** (5.1) including the cluster test and the raised limits; install review shows file
   hashes.
   **DONE** (commit 2ce1a37): migration 11 adds `widget_packages.content_hash`; `materialize.ts` (disk, atomic, hash-verified) and
   `materialize-db.ts` (15 s sync keyed on the hash, DB fallback for a node that is behind); verified in Docker by upgrading
   a v10 database (hashes backfilled, all 12 packages written under `/tmp/bosun-widgets`). Install review still to show file
   hashes (phase 2). A `.gitattributes` keeps the s6 files LF on Windows checkouts.
2. **Scripts runner, state probes, lookups** (5.2, 5.3, 5.4): generic runtime, poller integration, install review of
   scripts and network hosts.
   **DONE** (verified in Docker on a real SSH host, 473 tests): `runtime/script-run.js` (shared with the poller:
   parameters as environment variables, never in the script text; Linux script on stdin to a temp file, Windows quoted
   preamble; output protocol; typed key=value state parser; shared parameter validation), `runScript` in
   `execute.ts`, `collect/package-state.js` (script data collectors, per widget instance when settings feed the
   arguments, section `pkg:<type>#<widgetId>`; state probes into `pkg:<type>:state`; initial delay and period),
   `runtime/lookups.ts` (https only, manifest host allowlist, no redirects, refuses loopback/private/reserved addresses
   at connect time, size and time limits, cached), `loadRuntimeData` returns `state`, `stateError` and `lookups`,
   install review lists every script (account, file hashes, viewable text) and the network hosts and counts scripts
   toward the confirmation. The poller copies `script-run.js` in the Dockerfile.
   Carried forward: (a) a Windows live test of the script preamble waits for the real Windows scripts in phase 5;
   (b) script parameters reject newlines (as command parameters always did), so Custom Command in phase 5 needs a
   declared way to allow a multi-line value, or to stay single line; (c) the type-level `widget-data/<type>` route does
   not know the widget instance, so widgets with per-instance script data are read through `/api/widgets/<id>/data`;
   (d) the review of a package from the GitHub list shows scripts without text (the list fetches manifests only);
   (e) the poller refreshes its widget list every 30 s, so a changed setting takes up to 30 s to apply.
3. **Jobs** (5.5): table (migration), runtime, routes, audit, UI progress.
   **DONE** (verified in Docker on a real SSH host, 505 tests): migration 12 `package_jobs` (one running job per widget
   type and server through a partial unique index, heartbeat in `updated_at`, a job nobody updated for 90 s is `lost`,
   finished jobs kept 7 days); `jobs/store.ts`, `jobs/runtime.ts` (the node that gets the request runs the script,
   reads its output live through the new `onData`/`signal` options of `ssh.exec`, parses the generic protocol and
   writes steps and percent to the record every 1.5 s; the same write notices a cancel asked for on any node);
   cancel stops the script and everything it started (the script records its pid in `/tmp/bosun-job-<id>.pid`, the
   cancel command walks the process tree with pgrep or ps); script actions are now executable
   (`prepareScriptAction`: validate parameters, build the context state/data/config/lookups/server/param, first
   variant whose `when` holds, arguments from paths, literals or same-named parameters); routes: widget-actions answers
   202 `{jobId}` for `job: true` and the script result otherwise (optional `widgetId` for per-instance settings),
   `GET .../widget-jobs/<type>[?id=]`, `POST .../widget-jobs/<type>/<jobId>/cancel` (needs the starting action's
   permission); audit entries at start, finish and cancel; OpenAPI describes all of it.
   Carried forward: (a) the `jobProgress` block that shows a job in the widget is part of phase 4 (the API is ready);
   (b) `stores: "data"` ("check now") is not executed yet, it belongs to the port of OS Update Check; (c) the Windows
   side of job cancel (pid file in %TEMP%, taskkill /T) is untested until the Windows scripts exist in phase 5; (d) a job
   whose node stops is shown as lost, the script on the host may still finish; (e) only stdout carries the protocol; (f) the
   old in-memory Ollama and OS-update job code is still in core and goes in phase 5.
4. **Conditions, variants, UI blocks** (5.6, 5.7) in the declarative renderer, with a browser check (see section 8).
   **DONE** (517 tests; checked in the in-app browser against a showcase package on the nuc): `runtime/layout.ts` (pure,
   tested: block and badge visibility over the context data/state/config/lookups/server/job, which actions apply through
   their variant conditions, form and select values and the action parameters they build); `DeclarativeWidget` now holds
   the version 1 views as `V1View` (unchanged behaviour) and renders layout views through `LayoutView.tsx`: collapsible
   sections with condition-driven badges and a summary, key-value rows, text, notices, buttons, forms (start from the host's
   current value, keep what the person typed), selects, `jobProgress` (live percent, steps, Cancel, Dismiss, finished jobs
   hidden after 10 minutes) and nested `view` blocks; `useWidgetJob` polls the job (2 s while running); the data route
   returns `state`, `lookups`, the widget's settings and the server for version 2 widgets; actions send `widgetId`;
   `confirm.requireText` is now enforced by the dialog (also for version 1). Verified live: sections and badges from
   state and a real GitHub lookup, the "update available" notice, an invalid form value refused by the server and shown,
   confirm dialog with the server name, live progress 5% to 40% with steps, Cancel ending as cancelled, a delete dialog
   that stays disabled until the name is typed, no console errors beyond the expected 401/400.
   Carried forward: (a) no automated component tests (the project has no DOM test setup), the browser pass above is the
   check and must be repeated per ported widget; (b) a Read-only user's view and a narrow phone width of a layout are
   checked in phase 10; (c) `stores: "data"` still waits for the OS Update Check port.
5. **Port the three widgets together (phases 5, 6 and 7 as one step; see 4.1a).**
   **5a. Port Ollama**: write the package v2 (manifest, scripts per platform and install kind, layout view); move the
   current scripts over, replacing string interpolation with the parameter blob; delete `src/lib/ollama`, the four
   routes, the collector additions, the components, audit entries, seeded row, label map and `system-packages`
   leftovers. Keep permission ids and widget type. Re-run the full Ollama test matrix.
   **5b. Port OS Update Check**: probes per package manager and Windows Update (slow tier with initial delay, "check now"
   as an action), install as a job; delete the widget-specific data-route branches, the poller updates tier and
   `updates_requested_at` handling, `src/lib/updates` and the component.
   **5c. Port Custom Command**: generic command data source that reads the command and interval from instance settings,
   runs as the non-admin account, `requires_permission` on the command field; delete the component and the data-route
   branch.
   **DONE for Linux and Docker hosts** (457 tests, 23 more run in the Docker build on Linux; live on the nuc): all three are
   version 2 packages (`widgets/commands`, `widgets/updates`, `widgets/ollama` with 2.0.0, scripts per platform and
   install kind, layout views) and their code is gone from core: the components, `src/lib/ollama`, the Ollama routes,
   `src/lib/updates`, `custom-command.ts`, the poller's updates tier and `updates_requested_at` handling, the collectors'
   `ollama` and `updates` probes and parsers, the data route's custom-command, POST and snapshot branches, `snapshot-data.ts`,
   the audit entries, the label map entry and the `widget-policy` role rule. New generic pieces they needed: settings guarded
   by `requires_permission` (`config-guard`, used by the three widget routes and the settings dialog), `stores: "data"` and
   `after: "refresh"` (also for quick actions: the poller looks again at once), the `ago` format, `collectedAt` in the view
   context, script parameters with defaults need no mapping, alert metrics of the chosen server come from what it records.
   Verified live: upgrade from the previous image keeps every widget and its settings (packages 1.0.0 to 2.0.0); Custom Command
   output and the permission rule (an operator may not add or change a command); OS Update Check collected by the poller, check
   now and install as jobs, the list refreshing after an install; Ollama against a real container (detect, pull with progress,
   delete with confirmation, recreate for a setting with ports, volume and restart policy kept, update to a newer release,
   restart policy, stop and start, the loaded-models metric); the three widgets in the browser.
   Carried forward: (a) the Windows scripts (Custom Command, OS Update Check install via the SYSTEM task and job cancel, the
   whole Ollama Windows set) are written, ASCII-checked and reviewed but not yet run on a Windows host: needs a Windows live
   test with temporary authorised keys; (b) one running job per widget and server, so a model pull and an install no longer run
   side by side (the old code allowed several pulls); (c) with Ollama down the loaded-models metric records 0 instead of no sample;
   (d) a setting value of "default" removes the setting (the form sends it for an empty field); (e) the Ollama context length
   value is not range-checked beyond its digits any more.
8. **Docker package completion**: container actions, logs and the terminal action as package actions; remove the
   `/containers/**` routes and the `docker.*` special cases in the terminal route and OpenAPI; move the `docker` probe
   and `docker.running` metric into the package; Wake-on-LAN uses its own direct check.
9. **Guard rails and docs**: a test (and CI step) that fails if core sources mention a package's widget types, permission
   ids or snapshot sections (an allow-list file for the SSH Terminal); remove `customWidgetComponents`,
   `WIDGET_SECTIONS` and the widget names from `SNAPSHOT_SECTIONS`; write "Create your own widget" documentation with a
   small worked example package that is not shipped (and use it as a test fixture).
10. **Hardening and release**: upgrade test from the previous image (all widget types on a dashboard, then switch the
    image), multi-node test, a Read-only user's view, then ask the owner before any push to `main`.

Phases 1 to 4 are core work that can be built and tested without touching a host. Phases 5 to 8 each remove one
widget's code from core and are independently releasable.

## 7. Compatibility rules for the migration

- Widget types, permission ids and package ids do not change; existing dashboards, widget instances, permission
  groups and API keys keep working with no manual step.
- Bundled upgrade path: the new package versions replace the old ones through the existing seeding; v1 packages keep
  working next to v2.
- Stored data stays readable: snapshot sections other than the ones being moved are untouched; moved sections get a
  one-time cleanup of the old rows.
- Database migrations stay additive and numbered (current schema version 10; new tables such as `package_jobs`
  continue the sequence). Each migration runs in one transaction; nodes racing each other are tolerated.
- A package installed from GitHub or a zip is never changed by an image update.

## 8. Test strategy (what worked this time, keep doing it)

- **Unit tests** for every validator, parser, script builder and materialiser (vitest). The build runs them.
- **Local checks**: `npx vitest run` and `npx tsc --noEmit` (test files have pre-existing type noise; ignore
  those, watch for errors elsewhere). Node 26 is installed on the Windows dev machine; the Docker image uses Node 20.
- **Integration builds** run in Docker on the Linux build host: tar the repo over, `docker build` (the build runs
  the tests), start a throwaway Bosun container with its own volume, drive the real API with `curl`.
- **Linux hosts**: throwaway containers on an isolated Docker network (no published ports) acting as managed hosts
  with an SSH server; a Docker-capable fake host (Docker socket and CLI, SSH bound to the bridge address only) for
  container flows; a systemd container (privileged, private cgroup namespace) for service flows. Remove everything
  afterwards.
- **Windows host**: a real Windows machine with an administrator service account and a non-admin shell account is
  needed for Windows paths (services, nssm, winget, firewall, Windows Update). Authorise a temporary key for each test
  run and remove it afterwards; never touch the owner's real services or data without explicit permission; use
  separate service names, folders and ports for experiments.
- **What to verify per widget**: detection, every action, refusal paths (no confirmation, bad values, wrong kind),
  settings round trip, update path, the widget as a Read-only user, permission removal hiding the widget.
- **Not yet done anywhere: look at the widgets in a browser.** Add a browser pass (layout, collapsed sections,
  badges, dark mode, narrow widths) to phases 4 to 8.
- Gotchas found: the poller output on Windows has CRLF line endings and an empty block when nothing is installed;
  files written with `mktemp` are root-only; PowerShell stdin scripts do not accept multi-line blocks (send encoded
  commands instead); the `bosun-svc` Windows account may have no winget package source until it is repaired; shell
  here-documents mangle backslashes, so write files with an editor tool.

## 9. Risks and open questions

1. **Execution model** (4.1) is decided: declarative plus host scripts. If the owner later wants code packages, add a
   sandbox design document first; nothing in this plan builds one.
2. **Expressiveness limits.** Recreating a Docker container from `docker inspect` output is logic that today lives in
   TypeScript. In the package it has to be a host script (shell using Docker's own `--format` templates, or
   PowerShell on Windows). Decide early whether the declarative layer needs a tiny safe transform language
   (path, pick, join, map) or whether scripts always do the computing. Prototype with the Docker recreate before
   committing.
3. **Script trust.** Packages that run as the privileged service account are effectively root on the host. The install
   review must show scripts (not only commands) and hashes; consider requiring an extra confirmation for any
   package that uses the service account and a per-script account declaration.
4. **File limits and the database.** Larger packages mean larger rows in the replicated database; measure replication
   cost, keep files compressed in the row if needed.
5. **Partial upgrades.** A rolling cluster upgrade can have nodes on different Bosun versions reading the same
   package; spec versions and a `requires: { bosun: ">=x" }` field in the manifest should gate that.
6. **Windows variance.** PowerShell 5.1 only; winget behaviour differs between accounts and Windows editions; keep the
   fallbacks (nssm download) but test them.
7. **Poller load.** Package state probes add SSH work per server; keep per-package periods, run only for servers with
   an instance, and cap concurrent probes.
8. **Rollback.** Keep the previous package version in the database for one-click rollback after a bad upgrade.

## 10. Working agreements

- Develop on `dev`; commit often with the existing identity and message style; push `dev` when asked. `main` only
  after the owner has tested.
- Ask before: pushing to `main`, adding keys or changing anything on a machine the owner owns beyond a named test,
  using privileged containers outside an isolated network.
- Anything listed as "decision I made on my own" in the final report of a phase must be written into this document
  or the package README so it is not lost.
