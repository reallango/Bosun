# Widget packages

Each folder here is one package that Bosun can offer under **Settings → Widgets** (Available).
Bosun reads this folder from the branch chosen there (`main` by default, or `dev`).

A package folder is named after its package id and contains:

- `manifest.json` (required), see `_template/manifest.json`
- optional text files (JSON, Markdown, ...) next to it, up to two folders deep

Rules the manifest is checked against (a package that fails is listed as "skipped"):

- `schema` is `1`; `id` is 2-40 characters of `a-z`, `0-9`, `_`, starts with a letter, and equals the folder name.
- `version` is `major.minor.patch` (for example `0.0.1`). A higher version shows as an upgrade.
- `widgets` lists 1-10 widget types. Their fields are the ones on the Custom Widgets page
  (`display_name`, `description`, `icon`, `category`, `default_size`, `min_size`, `max_size`, `phone_height`,
  `refresh_interval`, `supports_linux`, `supports_windows`, `config_schema`). An optional `spec` object holds the
  declarative definition interpreted by the widget runtime.
- `permissions` lists the permissions the package adds. Ids must start with `<package id>.`, and a package may
  not imply a built-in high-risk permission. `defaultLevel` is `viewer` (everybody, including Read only), `operator` or `admin`.
- A package cannot use the id or widget type of a System widget (only the SSH Terminal is one now).
- `requires` (optional) names the widget API level the package needs: `{ "api": 3 }`. See
  [Widget API level](#widget-api-level).
- Folders starting with `_` are ignored (templates).

A package can also be exported from Settings → Widgets as a zip and imported on another Bosun
(`manifest.json` at the top of the zip, or inside one folder).

## Widget API level

Bosun has no semantic version number: an image is a git commit. A package that uses a newer spec key therefore says
which widget API level it needs:

```jsonc
"requires": { "api": 3 }
```

`requires` is optional; a package without it needs level 1. Bosun refuses a package whose level is higher than its
own on install, on upgrade from GitHub, on import from a file, and in the list of available packages, with
"This widget needs a newer Bosun (widget API level N; this Bosun has M). Update Bosun first." A package that needs a
newer Bosun is still listed under Available (so the reason is visible) but cannot be installed or upgraded.
`GET /api/health` reports the level as `widget_api_level`.

| Level | What it added |
| --- | --- |
| 1 | The original spec: `data` (snapshot and command sources), `view` (list, table, fields, text), `actions` (command and terminal), `metrics`, data filters, the unavailable notice, fields and gauges, and the formats. |
| 2 | Spec version 2 as it was before the additions below: `scripts` and package secrets, `state`, `lookups`, script actions with variants and jobs, `layout` views and editor blocks, screens, datasets, menu entries, multi-line text parameters, and stack import (`stacks` without its later keys); also `resources` on data and `target` on actions. |
| 3 | `stacks.retag`, `stacks.deployLater` and `stacks.deployPrivilegedLater` (which replaced the earlier `stacks.startLater`), `setup`, and the widget-size keys `hideBelow`, `row.inline` and `row.subtitleHideBelow`. |
| 4 | `bulk` on table views, the `stat` block, and the Manage-page keys of the earlier work: tab `count`, `open: "dialog"` on forms and editors, column `sort`, view `defaultSort`, and view `open` for row details. |
| 5 | `schedules`: the runs a package offers under Settings → Schedules. |

New spec keys that an older Bosun cannot honour raise the level in `src/lib/widgets/api-level.ts`; keys an older
Bosun can safely ignore (because it renders the widget sensibly without them) do not.

## Widget specs

A widget's optional `spec` makes it a *declarative* widget: Bosun renders it and runs its actions, with no
code in the package. It has four parts (see `src/lib/widgets/runtime/spec.ts` for the exact rules; a package
whose spec breaks them is rejected):

```jsonc
"spec": {
  "version": 1,
  "data": {                       // where the widget's rows come from
    "source": "command",          // "snapshot" (a poller section) or "command"
    "as": "service",              // command only: "service" (privileged account) or "shell" (non-admin account)
    "command": "docker ps -a --format '{{json .}}'",
    "windowsCommand": "...",      // optional; without it a command-based widget is not available on Windows
    "parse": "jsonlines",         // json | jsonlines | lines | text
    "map": { "name": "Names" },   // add fields: new name <- source field
    "path": "items",              // select a field of the parsed data
    "cacheSec": 10, "timeoutSec": 20,
    "permission": "my_package.view"   // required: who can see the widget and its data
  },
  "view": {
    "type": "list",               // list | table | text
    "summary": [{ "label": "running", "where": { "field": "state", "equals": "running" } }, { "label": "total" }],
    "filter": { "fields": ["name", "image"] },
    "toggles": [{ "key": "stopped", "label": "stopped", "default": true, "hideWhen": { "field": "state", "notEquals": "running" } }],
    "row": { "dot": { "field": "state", "colors": { "running": "green" } }, "title": "{name}", "subtitle": "{image}", "actions": ["restart"] }
  },
  "actions": [{
    "id": "restart", "label": "Restart", "icon": "rotate-cw",
    "permission": "my_package.control",   // required, and must be one the package declares
    "as": "service",
    "command": "docker restart {{name}}", // {{name}}: a declared parameter; Bosun quotes the value, do not add quotes
    "params": { "name": { "type": "string", "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$", "from": "name" } },
    "when": { "field": "state", "equals": "running" },
    "confirm": { "title": "Restart {name}?", "destructive": true },
    "result": "toast", "after": "refresh"
  }]
}
```

Rules that keep a package from becoming a way to run arbitrary commands:

- `data.permission` is required, and every action names a permission the package declares, so nothing can be seen or run until an admin grants it.
- A widget is hidden from dashboards, the Add Widget picker and the API for anyone who does not hold its data permission for that server (or whose group denies it).
- A command may only use `{{placeholders}}` for parameters the action declares. A string parameter needs an anchored
  `pattern` or a fixed list of `values`; a number needs `min` and `max`. Values are validated, then inserted as one quoted word.
- `as` is explicit on every command. `shell` is the non-admin account (no sudo, no Docker).
- Installing shows the admin every command, the account and the permissions, and asks for confirmation.
- **Terminal actions** (`"terminal": { "ref": "<row field>", "refPattern": "...", "command": "docker exec -it {{ref}} sh", "check": "<script>" }`) add a shell button that opens a terminal running that command on the host. The terminal asks for the person's own login and is only available to Full access users, in addition to the permission the action names. Over the API the same action, `POST /api/servers/:serverId/widget-actions/:widgetType/:actionId` with `{ "ref": "name" }`, returns a single-use token for an API terminal, for API keys holding the action's permission. The optional `check` script decides whether an API key may have the shell (it prints `ERROR: reason` to refuse, and `REF <exact target>` to pin what the shell opens); the Docker package uses it to refuse containers that can reach the host.

Each action is also an API endpoint, `POST /api/servers/:serverId/widget-actions/:widgetType/:actionId`, with
`{ "params": {...}, "confirm": true }`, and the data is at `GET /api/servers/:serverId/widget-data/:widgetType`.
`GET /api/openapi.json` describes all of them for the packages that are installed.

## Packages installed by default

`bundled.json` lists the package ids that every Bosun image installs on start (Docker Containers, Disk Usage,
System Services, Network, OS Info, CPU/Memory, GPU Monitoring, Server Summary, Metrics History,
OS Update Check and Custom Command). They are ordinary packages: an admin can remove them (a removed one is not
brought back at the next start, only by installing it again) and upgrade them from GitHub. A newer bundled
version replaces an older one that came from the image; a package the admin installed from GitHub or a zip is
left alone. Every bundled widget has a `<id>.view` data permission at the `viewer` level, so Read only users keep
their dashboards unless a group denies it.

Every one of them, including Ollama Status, OS Update Check, Docker Containers and Custom Command, is built only from
its manifest, scripts and declarative screen; Bosun has no code of its own for any of them. To write your own, see
[docs/create-your-own-widget.md](../docs/create-your-own-widget.md) and the example in `docs/examples/hello_host`.

## More of the spec

```jsonc
"spec": {
  "data": {
    "source": "snapshot", "section": "services",
    "also": ["metrics"],             // read more sections: the data becomes { services: ..., metrics: ... }
    "server": true,                   // ... and add the server's own details as "server"
    "filter": [{ "field": "status", "config": "filter", "all": "all", "default": "running" }],
    "unavailable": { "when": { "field": "available", "equals": false }, "message": "Docker is not available: {error}" }
  },
  "metrics": [                        // statistics tracked as history, with their own retention
    { "name": "cpu.usage", "label": "CPU usage", "unit": "%", "rawHours": 72, "rollup5mDays": 60, "rollup1hDays": 730 },
    { "name": "mypkg.running", "from": { "agg": "count", "where": { "field": "state", "equals": "running" } } }
  ],
  "view": { "type": "fields", "fields": [{ "label": "CPU", "value": "{cpu.usagePercent}", "format": "percent", "bar": "{cpu.usagePercent}" }] }
}
```

- `data.filter` keeps the rows whose `field` equals the widget setting `config` (a key of the widget's `config_schema`).
- `data.unavailable` shows a message instead of rows when the collected data matches (for example Docker is not installed).
- `data.also` and `data.server` combine several sections and the server row; templates reach them by name (`{system.prettyName}`, `{server.name}`, `{metrics.cpu.usage}`). The `metrics` section holds the latest value of every tracked number.
- `metrics` lists the statistics the widget tracks. A name the built-in collectors produce (`cpu.usage`, `mem.used_pct`, `net.rx_bps`, `disk.root_used_pct`, `gpu*.util`, ...) only sets how long its history is kept. A name that starts with the package id and has `from` is computed from the widget's data on every collection (`count`, `sum`, `avg`, `min`, `max` or `first`, optionally over the rows matching `where`). `rawHours` (up to 2160), `rollup5mDays` (up to 365) and `rollup1hDays` (up to 3650) override the global retention; when several widgets name one metric the longest wins. Computed metrics are recorded for the servers that have the widget on a dashboard.
- View types: `list`, `table` (columns may use `bar`, `mb`, `duration`, `temp` formats), `fields` (labelled values, optional gauges), `text`, and `chart` (history lines of `chart.metrics`). List rows can carry `fields` too.

### Schedules

A package can offer runs under Settings → Schedules. Bosun knows nothing about Docker or backups: it runs the
dataset or action a widget declares, on the timetable a user picks, with that user's permissions.

```jsonc
"spec": {
  "schedules": [
    {
      "id": "find_findings",
      "label": "Check for updates",
      "description": "Reads the image list and warns about newer tags.",
      "run": { "dataset": "updates" },        // or { "action": "update", "params": { "service": "web" } }
      "target": "server",                      // "server" (default), "stack" or "container"
      "options": { "args": { "all": true }, "keepRuns": 200 },
      "notify": {                              // dataset runs only
        "when": { "field": "available", "equals": true },
        "title": "{count} update(s) on {server}",
        "message": "The schedule {schedule} found {count} update(s) on {server}.",
        "severity": "warning"                  // "info" (default) or "warning"
      }
    }
  ]
}
```

- `id` is the kind's stable name (lowercase letters, digits and underscores); `label` is what the dialog shows.
- `run` names exactly one dataset or one runnable action (`script` or `command`). Action parameters are fixed here or
  come from the target; Bosun never fills in action parameter defaults, so every required parameter must be present.
  A dataset script may rely on its own declared defaults.
- `target` says the schedule is for the whole server, or for one stack/container. A `stack`/`container` kind must run a
  dataset or action that declares the same `target`; the dialog asks which one. `target` defaults to `server`.
- `options.args` are the dataset script's fixed arguments; `options.params` are action parameters (they override the kind's own `run.params`). `options.keepRuns` keeps 10–1000 finished runs (default 200).
- `notify` is for dataset runs only. Bosun counts the rows matching `when` (every row when it is absent) and raises one
  bell notice when the count is above zero, at most once per schedule per day. `{count}`, `{server}` and `{schedule}` are
  available in `title` and `message`.
- Every run re-checks the creator's permission for the server (and stack/container) plus the permission of the dataset or
  action. If a user is removed or disabled, an API key is revoked or expires, or a grant is withdrawn, the schedule pauses
  and one notice explains why. Only the cluster's database leader runs schedules.

### Widget sizes

Bosun measures the room each widget has on the dashboard (its content box, not the screen) and puts it in one of four
size classes: `xs` (under 280 px wide), `sm` (under 420), `md` (under 640) and `lg`. Dialogs and full pages always count
as `lg`. A spec can say what to drop on small widgets; older Bosun versions ignore these keys and show everything.

```jsonc
"view": {
  "type": "list",
  "filter": { "fields": ["name"], "hideBelow": "sm" },          // no filter box on an xs widget
  "toggles": [{ "key": "stopped", "label": "stopped", "hideWhen": {...}, "hideBelow": "sm" }],
  "summary": [{ "label": "total", "hideBelow": "md" }],
  "row": {
    "title": "{name}", "subtitle": "{image}", "subtitleHideBelow": "sm",
    "actions": ["logs", "shell", "restart", "stop"],
    "inline": { "xs": 0, "sm": 2, "md": 4 },                    // buttons per size; the rest go into a ⋯ menu
    "fields": [{ "label": "CPU", "value": "{cpu}", "hideBelow": "md" }]
  }
}
```

- `hideBelow` (`sm`, `md` or `lg`) works on every layout block (version 2), on `fields` items, table `columns`, `summary` entries, `filter` and `toggles`.
- `row.inline` sets how many row actions show as buttons at each size (a size it leaves out takes the nearest smaller one it names). Without it, a row shows 1 button on `xs`, 3 on `sm`, 5 on `md` and all of them on `lg`; the rest are in the row's ⋯ menu, in the order of `actions`.

The widget entry in the manifest can also say how large it may grow and how tall it should be when the dashboard
stacks widgets on a phone:

```jsonc
"widgets": [{
  "type": "my_package_widget",
  "display_name": "My widget",
  "default_size": { "w": 6, "h": 4 },
  "min_size": { "w": 4, "h": 3 },
  "max_size": { "w": 12, "h": 8 },     // optional cap, in base columns and rows
  "phone_height": 6                    // optional rows when stacked on a phone
}]
```

- `max_size` is scaled per breakpoint like `min_size`; the dashboard grid stops a resize at that size. Without it a
  widget may grow to the whole grid.
- `phone_height` replaces the 3-12 row clamp for widgets stacked on phones, so a stat tile can ask for 2 rows and a
  chart for 8. A phone arrangement the person saved still wins. `max_size` still caps the height when both are set.
- Both keys are optional and older packages keep their old behaviour. Older Bosun versions ignore them and use their
  own limits, so a widget that sets them must still look sensible there.

### Tabs, counts and create dialogs

A `tabs` block can show how many rows a tab lists: give the tab a `count` path (a list in the screen's context, such as
`datasets.images`). The chip is left out when the path is missing or does not hold a list. Tabs answer the arrow keys and
Home/End. On a full-page screen (`kind: "page"`) the open tab is kept in the URL as `?tab=<id>`, so a reload or a shared
link opens the same tab; an unknown id opens the first tab. Dialog screens and widgets on dashboards keep it in memory.

A `form` or `editor` block can sit behind a button instead of taking the top of the tab: add `"open": "dialog"` and a
`"label"` for that button (the label is required). Its submit buttons move to the dialog footer, and a successful submit
closes it. Without `open`, the block renders inline exactly as before. `"open"` accepts only `"dialog"`.

A dialog screen (`kind: "dialog"`) shows its `editor` blocks' submit buttons in the dialog's sticky footer, so the fields
can scroll while the buttons stay in reach. On a page screen, or in a widget on a dashboard, the same editor keeps its
buttons inline. The footer appears only when the screen has an editor with a usable submit.

When a tab's `buttons` blocks and dialog forms/editors come directly before a `view`, Bosun puts them on one row above the
view (right-aligned on wide screens) instead of stacking the blocks. Every button of that toolbar has the same height,
padding and font size. At most one is solid: the first dialog-form trigger, or else the first action that is not
destructive. The rest are outlined, and an action whose `confirm.destructive` is true gets the outlined destructive look.
Widget-sized toolbars use the same rule at a smaller size.

```jsonc
"blocks": [
  { "type": "tabs", "tabs": [
    { "id": "images", "label": "Images", "count": "datasets.images", "blocks": [
      { "type": "form", "open": "dialog", "label": "Pull image", "title": "Pull an image", /* fields, submit */ },
      { "type": "buttons", "actions": ["image_prune"] },
      { "type": "view", "path": "datasets.images" /* ... */ }
    ] }
  ] }
]
```

An older Bosun ignores these keys: it shows the tabs without counts and the forms inline, and a page still opens on its
first tab.

### Sortable tables and row details

A table can sort itself, over the rows it already has (nothing is asked of the host). Give a column a `sort` naming a
raw row field: the value the column shows may be formatted, so a "1.2 GB" column sorts by `size_bytes`. Values sort
numerically when both are numbers, otherwise as case-insensitive text (ISO dates order correctly as text). Clicking a
sortable header toggles ascending and descending and shows an arrow; `aria-sort` is set on the header. `defaultSort` names
the column (by title, which must have a `sort`) and the direction the table starts in.

A table or list can open a row's details: `"open": "<screen id>"` opens that screen in a side sheet (from the right on a
desktop, full screen on a phone) with the clicked row as the screen's `context`, exactly as a row action that opens a
screen would pass it. Rows answer Enter as well as a click. Without `open`, rows are not clickable.

```jsonc
"view": {
  "type": "table",
  "defaultSort": { "column": "Size", "dir": "desc" },
  "columns": [
    { "title": "Name", "value": "{name}", "sort": "name" },
    { "title": "Size", "value": "{size}", "sort": "size_bytes" }
  ],
  "open": "image_detail"
}
```

At the largest size class (a full-page or dialog screen, or a wide widget) a table shows at most two row actions as icons
and puts the rest in a per-row ⋯ menu, destructive actions last and in red. A smaller table keeps showing every action,
as before. An older Bosun ignores these keys and renders the table without sorting or row details.

### Bulk actions

A table can run a row action on several selected rows with one confirmation. Name the actions in `bulk`; every id must
also be one of `rowActions` and must be able to aim at a row (it declares a `target`, or takes a parameter `from` a row
field). On a page-size table (a full-page screen, not a widget on a dashboard) Bosun adds a checkbox column, and the
header checkbox selects every visible (filtered and sorted) row.

With rows selected, a bar above the table shows "N selected" and one button per bulk action the person may use on at least
one selected row. The action's permission is checked as for a single click, and its `when` decides which selected rows it
applies to; the others are skipped and counted. Clicking a button opens one confirmation that lists the affected rows
(the first 10, then "and N more") and uses the destructive style when `confirm.destructive` is true. Confirming sends one
request per row, in order, through the same endpoint a single row action uses, so every run is its own permission-checked
and audited request (or job). The dialog shows "3 of 5" progress; afterwards the selection clears, the table reloads, and
a toast reports how many succeeded, failed and were skipped. A bulk confirmation does not ask for `confirm.requireText`:
one row's name cannot confirm several rows. Without `bulk`, a table shows no checkboxes; an older Bosun ignores the key.

```jsonc
"view": {
  "type": "table",
  "columns": [{ "title": "Repository", "value": "{repo}" }, { "title": "Size", "value": "{size}" }],
  "rowActions": ["run_image", "image_remove"],
  "bulk": ["image_remove"]
}
```

### Stat tiles

A `stat` block is a responsive grid of number cards, for an overview tab: a big value, a small label and an optional
sub-line. `value` and `sub` are templates over the screen's context, like the values of a `kv` block.

- `tone` is either a fixed `"warning"`, `"danger"` or `"success"`, or an object mapping those tones to conditions. The
  first tone whose condition holds (in the order written) colours the number.
- `tab` names a tab of the same screen. Clicking the card switches to it; on a page screen it also updates `?tab=`.
  Outside a tab group the card stays static.

Cards use the theme tokens and follow the widget's size class: one column on `xs`, two on `sm`, three on `md` and four on
`lg`. The block also works in a widget on a dashboard. An older Bosun ignores the block, so a screen that uses it keeps
working there without the tiles.

```jsonc
"blocks": [
  { "type": "stat", "items": [
    { "label": "Running", "value": "{datasets.system.containers.running}", "sub": "of {datasets.system.containers.total}", "tab": "containers" },
    { "label": "Stopped", "value": "{datasets.system.containers.stopped}", "tone": { "warning": { "field": "datasets.system.containers.stopped", "gt": 0 } }, "tab": "containers" },
    { "label": "Images", "value": "{datasets.system.images}", "sub": "{datasets.system.disk.images}", "tab": "images" }
  ] },
  { "type": "kv", "items": [{ "label": "Docker version", "value": "{datasets.system.version}", "format": "text" }] }
]
```

## Docker Containers: backups and restore

Docker Containers 1.0.23 can back up a container or a Bosun-managed stack with [restic](https://restic.net/), run
as a short-lived `restic/restic` container with the data mounted read-only; nothing is installed on the host. Choose
the destination once per server in the widget's settings: a folder on the host (a mounted NAS counts), SFTP
(`sftp:user@host:/path`) or an S3-compatible endpoint (`s3:https://endpoint/bucket/prefix`). The destination and the
repository password are package secrets (`backup_repository`, `backup_password`, and `backup_credentials` for the SFTP
key or the S3 credentials). They reach the script only as `BOSUN_SECRET_*` environment variables; the key and the
credentials are written to mode-0600 temporary files, never to a command line, the output or a log. Initialise the
repository once from the Backups tab (the password reminder is shown there) and keep that password somewhere else:
without it the backups cannot be read.

A backup can include, per run: the container's named volumes (default on), its bind-mounted host folders ("mapped
drives", default on; sensitive paths such as `/`, `/etc` and `/var/run/docker.sock` are refused), the stored compose
file, `.env` and override of a Bosun-managed stack (default on), and the image itself through `docker save` (default
off; large). Every backup also stores a small metadata file with the container, its stack and service, the image
reference and id, its repo digest, the resolved version, labels, the mounts and where they belong, and the time.
The resolved version is the `org.opencontainers.image.version` label when present; otherwise the widget asks the
registry for the repository's tags (registry v2 `tags/list`, the same anonymous token as the image update check) and
looks for a version-looking tag whose digest is this image's digest, recording `repo:<tag>` as `pinned_ref`; without
one it records `repo@sha256:...`, which can still be pulled later.

Each run chooses the consistency (`live`, or `stop` to stop the container or stack first and always start it again,
also on failure) and the retention: `keep_last`, `keep_daily` (default 7), `keep_weekly` (4) and `keep_monthly` (6),
applied with `restic forget --prune` only to that container's or stack's snapshots (tagged `bosun:container=<name>`
or `bosun:stack=<name>`).

The Backups tab of the Manage page shows the destination, the snapshots with time, size, what was included and the
pinned version; open a snapshot to restore its data (stopping the container or stack first and starting it after),
optionally pin the image to that snapshot's version — a standalone container is recreated with the pinned image, a
Bosun-managed stack is redeployed with an extra `compose.backup-pin.yaml` override (the stored compose file is not
edited) — or restore into new volumes to inspect the data first, and to delete the snapshot. Container and stack row
menus also have "Back up", which runs with the defaults; the dialog with the inclusion and retention options is on
the Containers and Stacks tabs (the package already uses all 40 actions the spec allows, so a separate row-menu
dialog would need a core change). The new permissions are `docker.backup` ("Back up containers and stacks") and
`docker.restore` ("Restore backups"), both high and admin by default. The row actions take the container or stack
from the row and the Backups dataset declares its container/stack resources; because one action cannot name both a
container and a stack target, the actions themselves are checked at server scope (a core `target.byKind`, or a second
action per kind, would allow limiting them).

## Managing the Ollama installation

The Ollama Status widget shows how Ollama is installed and, with the `ollama.service` permission (Full access by
default), manages it:

| Host | Detected as | Controls |
| --- | --- | --- |
| Windows | service run by nssm, a plain Windows service, or a standard install | start, stop, restart, startup method (automatic, automatic delayed, manual, disabled), update; standard installs are shown but not managed |
| Linux | Docker container, systemd service, or a standard install | container: start, stop, restart, restart policy (never, always, unless stopped, on failure), update by recreating it with the same ports, volumes, GPU access and policy; systemd: start, stop, restart, enable or disable at boot, update |

When Ollama is not installed the widget offers to install it. On Windows that is a service run by nssm in
`C:\Ollama` (`bin`, `models`, `logs`, `nssm.exe`, the layout of existing installs), reachable from the network (all interfaces, port 11434, with an inbound firewall rule for private and domain networks unless a rule already allows the port) and
started at boot; the Windows archive is checked against the SHA-256 GitHub publishes for the release. On Linux the
default is a Docker container (`ollama/ollama`, models in the `ollama` volume, published on every interface (port 11434), restart
policy "unless stopped", GPU access when the NVIDIA runtime is present); without Docker the widget warns and offers the
official install script on the host instead (needs passwordless sudo). Install and update run as a job the widget
follows. A newer release (from GitHub, checked every six hours) shows as "Update available". Containers started by
Docker Compose are not recreated; update those with Compose.

API: `GET /api/servers/:serverId/ollama/service` (state, latest version, job) and
`POST /api/servers/:serverId/ollama/service` with `{ "action": "start|stop|restart|set_startup|set_restart_policy|install|update", "value", "method", "version", "confirm": true }`.

On Windows the installer needs nssm. It uses a copy that is already there (`C:\Ollama\nssm.exe` or on the PATH);
otherwise it checks that winget works for the service account (its program runs and its package source answers),
repairs it when it does not (registers the App Installer package, installs the winget source package from Microsoft's
CDN, installs winget itself if it is missing), and installs `NSSM.NSSM` with it. Only when winget cannot be made to
work does it download nssm from nssm.cc. The widget's Installation section is collapsed until opened, and shows an
"Update available" badge next to its arrow when a newer release exists.

### Ollama settings

The Installation section also shows the current `OLLAMA_CONTEXT_LENGTH` and `OLLAMA_MAX_LOADED_MODELS` ("Ollama
default" when a setting is not configured) and, with `ollama.service`, changes them. Where the values live depends on
the install: for an nssm service they are in its `AppEnvironmentExtra` (the other variables, such as `OLLAMA_HOST` and
`OLLAMA_MODELS`, are kept), for a plain Windows service in its `Environment` value, for a systemd service in the drop-in
`/etc/systemd/system/ollama.service.d/zz-bosun-settings.conf` (sorted last so it wins over other files), and for a Docker
container in its environment. Applying a setting restarts the service, or recreates the container from the image it
already has (no pull) with the same ports, volumes, GPU access and restart policy; "Reset to default" removes the
variable. Values are whole numbers (context length 512 to 4194304, loaded models 0 to 64) and are checked on the
server; the API action is `{ "action": "set_setting", "name": "OLLAMA_CONTEXT_LENGTH", "value": "16384", "confirm": true }`
(an empty value resets it).
