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
  not imply a built-in high-risk permission.
- A package cannot use the id or widget type of a System widget (the widgets built in to Bosun).
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

Each action is also an API endpoint, `POST /api/servers/:serverId/widget-actions/:widgetType/:actionId`, with
`{ "params": {...}, "confirm": true }`, and the data is at `GET /api/servers/:serverId/widget-data/:widgetType`.
`GET /api/openapi.json` describes all of them for the packages that are installed.
