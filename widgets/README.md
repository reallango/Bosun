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
  (`display_name`, `description`, `icon`, `category`, `default_size`, `min_size`, `refresh_interval`,
  `supports_linux`, `supports_windows`, `config_schema`). An optional `spec` object holds the declarative
  definition interpreted by the widget runtime.
- `permissions` lists the permissions the package adds. Ids must start with `<package id>.`, and a package may
  not imply a built-in high-risk permission. `defaultLevel` is `viewer` (everybody, including Read only), `operator` or `admin`.
- A package cannot use the id or widget type of a System widget (only the SSH Terminal is one now).
- Folders starting with `_` are ignored (templates).

A package can also be exported from Settings → Widgets as a zip and imported on another Bosun
(`manifest.json` at the top of the zip, or inside one folder).

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
- **Terminal actions** (`"terminal": { "container": "<row field>" }`, no command or parameters) add a shell button that opens the web  terminal in a container, like the built-in Docker widget. The terminal asks for the person's own login and is only available to  Full access users, in addition to the permission the action names. Over the API the same action, `POST /api/servers/:serverId/widget-actions/:widgetType/:actionId` with `{ "container": "name" }`, returns a single-use token for an API terminal in that container, for API keys holding the action's permission (instead of the built-in `docker.shell`). Containers able to reach the host are refused, as for any API container shell.

Each action is also an API endpoint, `POST /api/servers/:serverId/widget-actions/:widgetType/:actionId`, with
`{ "params": {...}, "confirm": true }`, and the data is at `GET /api/servers/:serverId/widget-data/:widgetType`.
`GET /api/openapi.json` describes all of them for the packages that are installed.

## Packages installed by default

`bundled.json` lists the package ids that every Bosun image installs on start (Docker Containers, Disk Usage,
System Services, Network, OS Info, CPU/Memory, GPU Monitoring, Server Summary, Metrics History, Ollama Status,
OS Update Check and Custom Command). They are ordinary packages: an admin can remove them (a removed one is not
brought back at the next start, only by installing it again) and upgrade them from GitHub. A newer bundled
version replaces an older one that came from the image; a package the admin installed from GitHub or a zip is
left alone. Every bundled widget has a `<id>.view` data permission at the `viewer` level, so Read only users keep
their dashboards unless a group denies it.

Ollama Status, OS Update Check and Custom Command have views that are compiled into Bosun (long running pulls,
installs and live commands); their packages carry the permissions, size, settings and tracked statistics, and the
`spec` only names the data permission.

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
