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

Nodes in a cluster share one database, so a package version one node installs is read by every node at once. A
version whose `requires.api` is above the lowest `widget_api_level` among the cluster's voter nodes is therefore not
written yet:

- the bundled seed leaves the installed version in place, logs
  `[widgets] deferred <id> <version>: needs API <n>, cluster minimum is <m>`, and retries when a rolling update
  finishes and every few minutes on the leader;
- an install from GitHub or a zip is refused with a message naming the nodes that are behind (a node that cannot be
  reached, or an old build without the field, counts as behind; a node that left the cluster is not in the voter
  list);
- the "update available" notice is not raised for it.

A node can still end up below an installed package's level, for example one restored from an old backup. Its widgets
then show "This widget needs a newer Bosun on this node (API level N; this node has M). Finish updating the cluster."
instead of "Unknown widget type", and the package's MCP tools are replaced by one tool that returns the same message
until the node is updated.

| Level | What it added |
| --- | --- |
| 1 | The original spec: `data` (snapshot and command sources), `view` (list, table, fields, text), `actions` (command and terminal), `metrics`, data filters, the unavailable notice, fields and gauges, and the formats. |
| 2 | Spec version 2 as it was before the additions below: `scripts` and package secrets, `state`, `lookups`, script actions with variants and jobs, `layout` views and editor blocks, screens, datasets, menu entries, multi-line text parameters, and stack import (`stacks` without its later keys); also `resources` on data and `target` on actions. |
| 3 | `stacks.retag`, `stacks.deployLater` and `stacks.deployPrivilegedLater` (which replaced the earlier `stacks.startLater`), `setup`, and the widget-size keys `hideBelow`, `row.inline` and `row.subtitleHideBelow`. |
| 4 | `bulk` on table views, the `stat` block, and the Manage-page keys of the earlier work: tab `count`, `open: "dialog"` on forms and editors, column `sort`, view `defaultSort`, and view `open` for row details. |
| 5 | `schedules`: the runs a package offers under Settings → Schedules. |
| 6 | Up to 64 actions per widget (40 before). |
| 7 | `looks` (and the "Look" choice Bosun adds to the widget's settings), `trend` on stat tiles and fields, the stat tile keys `bar`, `unit` and `thresholds`, and the `gauges` block. |
| 8 | The bounded sizing keys: `size`, `minItemWidth` and `columns` on `stat` and `gauges`, `thickness` on gauges, `emphasis` and `decimals` on their items, and the widget-level `density`. A `%` value (and the `percent` format) now shows at most one decimal and a whole number from 100 up. |
| 9 | `before` on an action variant: a package script that runs first, and the action does not run when it fails (used to take a backup before an update); and `target.byKind` on actions and datasets (a target whose kind comes from one of its parameters, so one action can act on a container or a stack), with `"byKind"` as a schedule target. |
| 10 | The `meters` block (a compact bar or small ring per row of a data list), `count` and `format` on a stat tile, `format` on a ring gauge, the `rate` value format on fields, tables, tiles and gauges, and dotted data keys (a metric named `cpu.usage` is reached as `{data.metrics.cpu.usage}`). |
| 11 | Per-look sizes (`min_size` and `default_size` on `looks.options`), `when` and `alternatives` on `stat` and `gauges` items and `when` on `meters` rows, the `info` block and the `footer` key on `stat` and `gauges`, `layout` on `meters`, and `count` in conditions. |
| 12 | Reserved for the open credential-manager PR (#59): a package `credentials` block and `BOSUN_CRED_*` variables. This change does not use level 12, so the two can merge without renumbering. |
| 13 | A `gauges` block that draws one ring per row of a data list (`path` with `item` and `empty`), `format` on the `label value` pairs of an `info` block or a block's `footer`, and a per-look `min_size`/`default_size` that may exceed the widget's default size (up to its `max_size`), so a look such as a per-core grid can ask for the room it needs. |

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
version replaces an older one that came from the image or from GitHub — both are this same repository, so the
package's secrets are kept; a zip upload is left alone. Widget changes are released through this GitHub channel,
not through a new image: the image workflow skips widget-only commits, so the folder here can be newer than the
image that installed the package. Every bundled widget has a `<id>.view` data permission at the `viewer` level, so
Read only users keep their dashboards unless a group denies it.

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
- In a version 2 `layout` view, the widget's data is under `data` (`{data.system.prettyName}`, `{data.metrics.cpu.usage}`); the server row is also at the top level (`{server.name}`). A data key that itself contains dots, such as a metric named `cpu.usage`, is reached by its full path: the longest key that matches wins, so `{data.metrics.cpu.usage}` reads `metrics["cpu.usage"]`.
- `metrics` lists the statistics the widget tracks. A name the built-in collectors produce (`cpu.usage`, `mem.used_pct`, `net.rx_bps`, `disk.root_used_pct`, `gpu*.util`, ...) only sets how long its history is kept. A name that starts with the package id and has `from` is computed from the widget's data on every collection (`count`, `sum`, `avg`, `min`, `max` or `first`, optionally over the rows matching `where`). `rawHours` (up to 2160), `rollup5mDays` (up to 365) and `rollup1hDays` (up to 3650) override the global retention; when several widgets name one metric the longest wins. Computed metrics are recorded for the servers that have the widget on a dashboard.
- The host snapshot also carries the newer collector fields: `cpu.cores` (`[{ "id": 0, "usagePercent": 42 }]`, snapshot only; `cpu.coreCount` is the count), `disk_io` (`readBps`, `writeBps` and per-device `devices`) with the `disk.read_bps` / `disk.write_bps` metrics, `disks[].readBps` / `writeBps` on a mount that maps to a device, and `network_headline` (`name`, `ipv4`, `state`, `macAddress`) for the interface with the default route.
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

A tile can also carry a thin bar, a unit, a small trend line and thresholds (level 7):

- `bar` is a template that gives a number from 0 to 100, drawn as a thin bar under the number.
- `unit` is appended to the value (`%` and `°C` sit tight, other units take a space). Keep `value` a plain number when
  you use thresholds, or they cannot compare it.
- `trend` is `{ "metric": "cpu.usage", "window": "1h" }`: a small line of that metric's history. `window` is `1h`, `6h`
  or `24h`. A host with no history draws nothing; it is not an error.
- `thresholds` colours the number and the bar: `{ "warning": 75, "danger": 90 }` for "high is bad", or
  `{ "below": { "warning": 20, "danger": 10 } }` for "low is bad". A fixed `tone` or a tone condition wins over it.
- `trend` is also accepted on a `fields` item (a `fields` view or a `kv` block); it draws the line under the value.
- `decimals` (0-3) and `emphasis` (`normal` or `muted`) tune the number and its weight; `size`, `minItemWidth` and
  `columns` tune the block. See [Tuning sizes](#tuning-sizes) (level 8).
- `count` makes the number the size of a list instead of a value: `{ "path": "data.models", "where": { "field": "state", "equals": "running" } }`.
  `path` is a dotted path into the widget's data (default: the data itself) and `where` is optional. A missing list
  counts as zero. Use it for "3 running" when the data is a list of rows rather than a number (level 10).
- `format` writes the value the way a list column does: `bytes`, `rate` (bytes per second), `mb`, `temp`, `duration`,
  `percent`, `ago` or `until` (level 10). A `percent` format honours `decimals`; the others choose their own precision.
  The `bar` and thresholds still read the raw number.
- `when` hides the tile while its condition does not hold, and `alternatives` lists fallback tiles tried in order
  (level 11). The first alternative whose own `when` holds is drawn; with no match the tile is left out. This is how
  "show the errors when there are any, else the average uptime" stays one card:

```jsonc
{ "type": "stat", "items": [
  { "label": "Errors", "value": "{data.errors}", "tone": "danger", "when": { "field": "data.errors", "gt": 0 },
    "alternatives": [{ "label": "Avg uptime", "value": "{data.avgUptime}", "format": "duration" }] }
] }
```

- `footer` adds a muted `label value` line under the block (level 11), for small facts that do not deserve a tile.
  Each pair is `{ "label": "...", "value": "...", "when": { ... } }`; `when` is optional and hides that pair. The line
  truncates and stays pinned to the bottom of the widget. See [Info line](#info-line).
- A condition may compare the length of a list: `{ "count": { "path": "data.mounts", "where": { ... } }, "gt": 1 }`.
  `where` is optional and is itself a condition read against each row; the comparison (`equals`, `gt`, `gte`, `lt`,
  `lte`) is the usual top-level one (level 11):

```jsonc
{ "count": { "path": "data.mounts", "where": { "field": "usedPercent", "gte": 90 } }, "gt": 0 }
```

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

### Looks

A widget can offer named ways to draw its main numbers. Bosun adds a "Look" choice to that widget's settings dialog
automatically and exposes the saved value to conditions as `config.look`, so the spec decides what each look shows:

```jsonc
"spec": {
  "looks": { "default": "tiles", "options": [{ "id": "tiles", "label": "Tiles" }, { "id": "gauges", "label": "Gauges" }] },
  "view": { "type": "layout", "blocks": [
    { "type": "stat", "when": { "field": "config.look", "equals": "tiles" }, "items": [ /* ... */ ] },
    { "type": "gauges", "when": { "field": "config.look", "equals": "gauges" }, "items": [ /* ... */ ] }
  ] }
}
```

- `looks.options` is 1-6 looks; each `id` is lowercase letters, digits and underscores and each `label` is what the
  settings dialog shows. `default` must be one of the ids.
- A look may declare its own grid sizes (level 11): `min_size` replaces the widget's minimum while that look is
  selected, and `default_size` is the size the settings dialog suggests for it. Both are `{ "w": 1-48, "h": 1-48 }`.
  A look minimum may be larger than the widget's `default_size` (level 13), up to the widget's `max_size` when it sets one;
  a look such as a per-core grid needs more room than the widget opens at. When a person switches look, Bosun lowers or raises
  the instance's `grid_min_w`/`grid_min_h` to the look's minimum, and grows the instance if its current size no longer
  fits. Bars can therefore need less room than tiles:

```jsonc
"looks": { "default": "tiles", "options": [
  { "id": "tiles", "label": "Tiles", "min_size": { "w": 4, "h": 3 } },
  { "id": "bars", "label": "Bars", "min_size": { "w": 2, "h": 2 }, "default_size": { "w": 3, "h": 4 } }
] }
```
- The value is stored with the widget's other settings in `widgets.config`. Bosun fills in the default before the
  widget's data is sent, so conditions work even before anyone opens the settings.
- Conditions on `config.look` need the context of a layout block (`when` on a block, or a `kv` field). A version 1
  `fields` view tests conditions against the data, not the settings.
- A widget without `looks` is unchanged and gets no extra setting.

### Ring gauges

A `gauges` block draws circular gauges with the value in the middle. It is a sibling of `stat`, and uses the same
conditions and size classes.

```jsonc
{ "type": "gauges", "items": [
  { "label": "CPU", "value": "{data.cpu.usagePercent}", "max": 100, "unit": "%", "thresholds": { "warning": 75, "danger": 90 }, "sub": "8 cores" },
  { "label": "Memory", "value": "{data.memory.usagePercent}", "max": 100, "unit": "%", "thresholds": { "warning": 75, "danger": 90 } }
] }
```

- `value` is a template; `max` is what a full ring stands for (default 100).
- `unit`, `thresholds`, `sub`, `decimals` and `emphasis` work as they do on a stat tile.
- `format` writes the value as a byte count, a rate, MB, °C or a duration (level 10), while `max` and the thresholds
  still read the raw number.
- `thickness` (`thin`, `normal` or `thick`) sets the ring stroke, on the block or on one item. See
  [Tuning sizes](#tuning-sizes) (level 8).
- Items accept `when` and `alternatives` like stat tiles (level 11). `footer` works on the block too.
- A `gauges` block can draw its rings from a data list instead of listing them (level 13): give `path` (a dotted path
  into the widget's data) and one `item` template, and the block draws one ring per row, in the same balanced
  arrangement as fixed items. The row's fields fill `label`, `value` and `sub`; the item's `when` and `alternatives`
  are read against that row. `empty` is shown when the list has no rows.

```jsonc
{ "type": "gauges", "path": "disks", "empty": "No disk data",
  "item": { "label": "{mountPoint}", "value": "{usagePercent}", "max": 100, "unit": "%",
            "sub": "{filesystem}", "thresholds": { "warning": 80, "danger": 90 } } }
```

- The ring uses theme tokens only and is announced to assistive technology as an image (`role="img"` with the label and
  value as its `aria-label`).

### Meter rows

A `meters` block draws one compact row per item of a data list: a bar, or a small ring, with the label and value on the
same line. It is for a list of similar things where each has its own share (mounts, GPUs, interfaces) and a grid of
large tiles would waste the room.

```jsonc
{ "type": "meters", "path": "mounts", "shape": "bar", "empty": "No mounts",
  "item": { "label": "{mount}", "value": "{used_percent}", "unit": "%", "sub": "{filesystem} · {size}",
            "thresholds": { "warning": 80, "danger": 90 } } }
```

- `path` is a dotted path into the widget's data; the block draws one row per array item. An object is one row and a
  missing list draws the `empty` text.
- `shape` is `bar` (default) or `ring` (a small ring at the left of each row).
- `layout` is `rows` (default) or `grid` (level 11). `grid` packs many small meters into as many columns as fit, each a
  thin vertical bar with its label underneath; it is what a per-core CPU widget needs (4 to 64 cores stay readable).
- `item.when` hides the rows whose condition does not hold (level 11), so a meter list can show only the cores above a
  threshold, or only the mounts that are in use. `grid` and `item.when` together draw a per-core CPU widget:

```jsonc
{ "type": "meters", "path": "cores", "shape": "bar", "layout": "grid",
  "item": { "label": "{id}", "value": "{usagePercent}", "max": 100,
            "when": { "field": "usagePercent", "gt": 5 } } }
```
- `item` is the row template: `label` and `value` are templates over the row (like a list row's fields), `max` is what
  a full bar or ring stands for (default 100), and `unit`, `sub`, `thresholds`, `decimals` and `emphasis` work as they
  do on a stat tile.
- A `meters` block is a list, so it takes the room the other blocks leave and scrolls; it does not use the filling
  tile grid. `layout: rows` spreads its rows over the height they get, and the bar thickness and text scale a little
  with the room. In a widget of about three rows it tightens its gaps and drops the `sub` line, keeping every row's label
  and value. When it does fill the body, it scales its bar thickness and text modestly with the spare height (container
  query units with a readable minimum and maximum), like tiles.
- The rows are plain text and theme tokens; the bar is the same one a stat tile uses and the ring is the same
  geometry, at a fixed small size.

### Info line

An `info` block is one muted line of `label value` pairs, for the small facts that should not take a whole tile:
"2 mounts", "3 interfaces · eth0 192.168.1.130", "Uptime 31d 6h". `stat` and `gauges` take the same list as a `footer`
instead (level 11).

```jsonc
{ "type": "info", "items": [
  { "label": "Mounts", "value": "{data.mounts.length}" },
  { "label": "{data.network_headline.name}", "value": "{data.network_headline.ipv4}", "when": { "field": "data.network_headline.ipv4", "exists": true } },
  { "label": "Uptime", "value": "{data.uptime}" }
] }
```

- Each pair needs a `label` and a `value`; both are templates over the screen's context.
- A pair may carry `format` (level 13) to write its value like a field: `bytes`, `rate`, `percent`, `mb`, `temp`,
  `duration`, `ago` or `until`. Without it the template's text is shown as it is.
- Pairs may carry `when`; a pair whose condition does not hold is left out.
- The pairs are separated by " · ", truncate instead of wrapping, and stay pinned to the bottom of the widget body.
- `footer` on a `stat` or `gauges` block takes exactly the same list and sits under that block.

### Filling the widget

Inside a widget on a dashboard, `stat` tiles and `gauges` flow into a grid that rearranges itself for the widget's width
and height: the columns and rows are chosen so every row holds the same number of items (see [Arrangement](#arrangement)).
A `meters` block, and a `view` block that draws a list, table or chart, takes the room the other blocks leave instead (it
scrolls inside it). Each card is a size container: the number in a tile, the value in a ring and the label above them scale
with the card's width and height (container query units), not with the screen, within a sensible minimum and maximum.
The renderer also shortens a number for its own length: it counts the characters of the value and its unit and picks a
size whose text stays inside the card (about 70% of the ring's inner circle). Every tile or gauge in one block takes
the size chosen from that block's longest value, so "8%" and "89.9%" sit at the same size instead of one being huge.
The number never drops below a readable floor (0.9rem in a tile, 0.75rem in a ring). When the number and its unit
cannot both fit at that floor, they are split: the number keeps the first line and the unit follows on a smaller line
under it. A `%` is part of the number and stays attached ("89.9%") unless even the bare number cannot reach the floor.
The decision is made once for the whole block from its widest value, so every tile or gauge in it has the same shape.
A number with a `%` unit (and the `percent` format) shows at most one decimal and a whole number from 100 up, so a full
ring reads "100%", never "100.0%"; this works whether the data arrives as a number or as a numeric string. A sparkline
stretches to the tile's width and its height follows the card. In a dialog, a sheet or a full page the same blocks keep
their normal reading size.

A widget of about three grid rows switches these blocks to a compact layout: the padding and gaps shrink, a tile drops
its sparkline and sub-line (the number and bar stay), a gauge moves its label inside the ring under the value, and a
`text` block is kept to one truncated line. When a compact gauge's value has split its unit, the label moves below the
ring instead, so the ring keeps two lines; the ring's `title` and `aria-label` still name it. The result must fit
without clipping the ring or the footer. Lowering a package's `min_size` in an upgrade also lowers the stored minimum
of the widgets already on dashboards, so they can be made smaller without removing and adding them again.

Bosun applies these rules for every widget (they are not per widget). A spec only chooses the look and what each block
shows; it does not need any layout CSS of its own.

#### Arrangement

The renderer measures the room a `stat` or `gauges` block has and lays its items out in **balanced rows**: every row holds
the same number of items, so the column count always divides the item count and no row is left half empty. Only the
items that actually render are counted, after `when` and `alternatives` have been resolved. The grid follows the widget
while it is resized, and the item cards, labels, values and the footer info line keep their own rules.

The candidates are the divisors of the item count, each with `rows = items / columns`. The renderer keeps the one that
makes each item largest:

- **Gauges** take the candidate with the largest `min(cellWidth, cellHeight)`, because the ring is square: a wide box
  puts rings side by side, a tall narrow box stacks them.
- **Stat tiles** take the candidate with the largest cell area, discounted by how far the cell's aspect is from about
  1.4:1 (a little wider than tall). A tile is never made narrower than its widest value needs at the readable floor
  (see above), so a long value moves a tile to a row of fewer, wider cells.
- A tie goes to the arrangement with fewer rows, which uses the width first.

| Items | Arrangements | In a wide box | In a tall box |
| --- | --- | --- | --- |
| 2 | 2x1 or 1x2 | 2x1 | 1x2 |
| 3 | 3x1 or 1x3 (never 2 + 1) | 3x1 | 1x3 |
| 4 | 4x1, 2x2 or 1x4 | 4x1 | 1x4 |
| 5 | 5x1 or 1x5 | 5x1 | 1x5 |
| 6 | 6x1, 3x2, 2x3 or 1x6 | 6x1 (gauges), 3x2 (tiles) | 1x6 |
| 7 | 7x1 or 1x7 | 7x1 | 1x7 |

The block's own keys still decide first:

- `columns` (a fixed count) wins over the arrangement and keeps that many columns.
- `minItemWidth` is a lower bound: a candidate whose cells would be narrower than it is left out. If every candidate is
  narrower than the bound, the widest one wins, because width is then the binding constraint.
- A compact widget (short height, or `density: "compact"`) uses the smaller gap, and the arrangement follows it.

This is renderer behaviour, not a new key: a spec needs no extra `requires.api` level and no layout CSS of its own.

#### Tuning sizes

A widget author can adjust the sizes without CSS or class names. Every key below is validated like the rest of the
spec: an unknown value fails with a clear message, and each one maps to a fixed, theme-token class in Bosun. The sizes
still scale with the card (container query units) and keep their minimum and maximum, so nothing can overflow. A
package that uses any of these keys must declare `"requires": { "api": 8 }`.

| Key | Where | Values (default first) | What it does |
| --- | --- | --- | --- |
| `size` | `stat`, `gauges` | `"md"` (default), `"sm"`, `"lg"` | Scales the value and the label together. |
| `minItemWidth` | `stat`, `gauges` | `"md"` (default), `"xs"`, `"sm"`, `"lg"` | The smallest width of a tile or gauge cell: the arrangement drops candidates narrower than it, and the fallback grid uses it before the body is measured. |
| `columns` | `stat`, `gauges` | the balanced arrangement (default), or a whole number 1-6 | A fixed number of columns instead of the arrangement. |
| `thickness` | `gauges` block or item | `"normal"` (default), `"thin"`, `"thick"` | The width of the ring stroke. An item overrides its block. |
| `emphasis` | `stat` or `gauges` item | `"normal"` (default), `"muted"` | Dims the value of a secondary item. A tone still wins on the number. |
| `decimals` | `stat` or `gauges` item | `%`: 1 (default); other values: as given; 0-3 | The most decimals the value shows; trailing zeros are dropped and a `%` value from 100 up is whole. |
| `density` | the widget's `spec` | `"comfortable"` (default), `"compact"` | Shrinks paddings and gaps. A short widget still switches to compact by itself. |

```jsonc
"spec": {
  "version": 2,
  "density": "compact",
  "data": { "source": "snapshot", "section": "cpu_memory", "permission": "cpu_memory.view" },
  "view": { "type": "layout", "blocks": [
    { "type": "gauges", "size": "lg", "minItemWidth": "lg", "thickness": "thick", "items": [
      { "label": "CPU", "value": "{data.cpu.usagePercent}", "unit": "%", "decimals": 1, "thresholds": { "warning": 75, "danger": 90 } },
      { "label": "Memory", "value": "{data.memory.usagePercent}", "unit": "%", "emphasis": "muted" }
    ] },
    { "type": "stat", "size": "sm", "columns": 2, "items": [
      { "label": "Disk used", "value": "{data.disk.usedGb}", "unit": "GB", "decimals": 1 }
    ] }
  ] }
}
```

## Docker Containers: backups and restore

Docker Containers 1.0.28 can back up a container or a Bosun-managed stack with [restic](https://restic.net/), run
as a short-lived `restic/restic` container with the data mounted read-only; nothing is installed on the host. Choose
the destination once per server in the widget's settings: a folder on the host (a mounted NAS counts), SFTP
(`sftp:user@host:/path`) or an S3-compatible endpoint (`s3:https://endpoint/bucket/prefix`). The destination and the
repository password are package secrets (`backup_repository`, `backup_password`, and `backup_credentials` for the SFTP
key or the S3 credentials). They reach the script only as `BOSUN_SECRET_*` environment variables; the key and the
credentials are written to mode-0600 temporary files, never to a command line, the output or a log. Initialise the
repository once from the Backups tab (the password reminder is shown there) and keep that password somewhere else:
without it the backups cannot be read.

The repository is created as restic format version 2, so it compresses data (`--compression auto`, the default for
version 2). A repository created by an older Bosun can stay version 1; it works, but it stores uncompressed. To
compress it, stop the backups and run `restic migrate upgrade_repo_v2` once against the repository. Bosun does not
migrate it automatically. An image saved with `docker save` is a plain tar, written uncompressed (restic then chunks
and compresses it like any other data), so restic's content-defined chunking can still skip the unchanged parts of a
later image.

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

Backups are incremental. Restic stores each file once as content-defined chunks and a later snapshot references the
chunks it already has, so every backup after the first stores only the data that changed. The widget also tells restic
which snapshot to use as the parent: it looks up the latest snapshot of the same container or stack
(`restic snapshots --json --latest 1 --tag bosun:container=<name>`) and passes its id as `--parent`. Without that,
restic would pick a parent by host and paths, and since every target uses `--host bosun` and the same `/bosun` paths,
it would often compare against another target's snapshot and read and hash all of this target's unchanged files
again. When there is no earlier snapshot, or the lookup fails, the backup runs without `--parent`.

Restic's summary says how much this run actually added (`data_added`, or `data_added_packed` when present), and the
widget records it as `bosun:added=<bytes>` next to the file counts (`bosun:added_files=new/changed/unchanged`). The
Backups tab shows both the full size of a snapshot and what it added (for example "4.2 GB · added 38 MB"), and the
repository's real size on disk comes from `restic stats --mode raw-data` and is shown next to the destination, so the
space the backups really use is visible. Retention frees space: `restic forget --prune` drops the snapshots that are
older than the keep rules and then removes the data no remaining snapshot needs. Until that runs, deleting a snapshot
alone does not free its data.

The Backups tab of the Manage page shows the destination and the repository size on disk, the snapshots with time,
full size, added size and file counts, what was included and the pinned version; open a snapshot to restore its data
(stopping the container or stack first and starting it after), optionally pin the image to that snapshot's version — a
standalone container is recreated with the pinned image, a Bosun-managed stack is redeployed with an extra
`compose.backup-pin.yaml` override (the stored compose file is not
edited) — or restore into new volumes to inspect the data first, and to delete the snapshot. Container and stack row
menus have **Back up** (one click with the defaults) and **Back up…**, which opens the same inclusion and retention
options in a dialog, prefilled with the row's container or stack. The dialog's submit (`backup_run`), the quick
action and the Backups dataset declare their container or stack target with `target.byKind`, so a grant limited to one
stack or container covers them. The permissions are `docker.backup` ("Back up containers and stacks") and
`docker.restore` ("Restore backups"); both are high and admin by default and can be limited to a stack or container
like the other Docker permissions.

Settings → Schedules offers **Back up a container or stack** with the standard options (volumes, mapped folders,
stack files, live consistency, daily/weekly/monthly retention). It runs as an ordinary job and re-checks
`docker.backup` on the target every time; a failure raises a bell notice, and a success raises one too. The backup
settings are stored with the schedule (`options.params.settings`), so an API caller can override them per schedule.
The package also offers **Back up, then update** for a container and for a stack, and the matching schedules; they
need `docker.backup_update` (which implies `docker.backup` and `docker.manage`) and take a restic backup first,
stopping before the update when the backup fails.

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

## Docker Containers: manual updates

The Docker Containers package (1.0.28) can install a newer image by hand, one container or all at once, with a
health check and an automatic rollback. On the Manage page, the Containers tab lists every container whose registry has
a newer image for the tag it runs; each row with an update has an **Update** action, and the table's selection offers the
same action as a bulk update (select the rows, or the header checkbox for all of them). The Stacks tab has **Update
images** for a Bosun-managed stack.

What the update does:

- Pulls the image reference the container (or the stack's services) already runs; the tag is not changed.
- Compares the pulled image id with the one the container runs. If they are the same, nothing is touched.
- Otherwise rebuilds the container with the same settings on the new image (the same reconstruction `export_run` uses:
  command, entrypoint, environment, ports, volumes, labels, restart policy, resources, network, healthcheck and the
  preserved options), renames the old container to `<name>-bosun-old` while it works, and removes it only after the new
  one is healthy. The previous image is kept; the self-update clean-up keeps one, and general image clean-up stays with
  the person.
- Waits up to `health_timeout` seconds (default 180) for every updated container to be running and, where it defines a
  Docker healthcheck, healthy. A container without a healthcheck only has to keep running.
- On a timeout, an unhealthy container or a failed create/start, removes the new container, renames the old one back,
  starts it when it was running, and fails the job with `rolled back: <reason>`.

For a stack, only the services whose image id changed are recreated (`docker compose up -d --no-deps <services>`); the
others are left alone. A stack Bosun did not create has no stored compose file and is refused ("import it first").
Bosun's own container or stack is refused ("use Settings → Updates"), so the self-update path keeps owning that.

Both actions need `docker.manage`, the same permission as editing a container and redeploying a stack; no new
permission is introduced. The row menus also offer **Back up, then update** (and **Back up, then update images** for a
stack): the same update path after a restic backup of the container or stack, and the update does not start when the
backup fails. Those actions need `docker.backup_update`, which implies `docker.backup` and `docker.manage`; they are
off by default because they are a separate choice, not a checkbox on the ordinary update. Settings → Schedules can
apply an image update to a chosen container or stack (**Update a container's image**, **Update a stack's images**) or
the same with a backup first. Each run re-checks `docker.manage` (or `docker.backup_update`) on the target and raises a
bell notice with what was updated, rolled back or failed. Over the API:
`POST /api/servers/:serverId/widget-actions/docker/container_update` with
`{ "params": { "name": "<container>", "stack": "", "service": "", "health_timeout": 180 }, "confirm": true }` (for a
compose service, `stack` and `service` are the service's values), and
`POST /api/servers/:serverId/widget-actions/docker/stack_update_images` with
`{ "params": { "name": "<stack>", "health_timeout": 180 }, "confirm": true }`. For the backup-first actions use
`container_update_backup` and `stack_update_images_backup` with the same parameters plus `settings` (the backup
settings blob).
