# Create your own widget

A widget in Bosun is a **package**: a folder with a `manifest.json` and the scripts it runs. Everything the widget
needs lives in that folder: its settings, its permissions, the scripts that collect data or do things on the host,
and the screen that shows the result. Bosun itself contains no code for any one widget, which is why you can write
your own without changing Bosun. The bundled widgets (Docker, Ollama, OS Update Check, Custom Command, ...) are
ordinary packages built the same way; read them in `widgets/` when you need a larger example.

The worked example below is in `docs/examples/hello_host/`. It is not installed by default; a test keeps it valid.

## The shape of a package

```
hello_host/
  manifest.json          required
  scripts/hello.sh       Linux script
  scripts/hello.ps1      Windows script (PowerShell)
```

The folder name is the package id (`a-z`, `0-9`, `_`, starts with a letter, 2-40 characters). Text files may sit
next to the manifest, up to two folders deep.

## 1. Describe the package

`manifest.json` names the package, the permissions it adds and the widgets it offers:

```jsonc
{
  "schema": 1,
  "id": "hello_host",
  "name": "Hello Host",
  "version": "1.0.0",                          // a higher version shows as an upgrade
  "description": "...",
  "author": "You",
  "permissions": [{
    "id": "hello_host.view",                   // must start with "<package id>."
    "label": "See Hello Host widgets",
    "description": "See the widget and the output of its script.",
    "group": "Hello Host",
    "defaultLevel": "viewer",                  // viewer (everybody) | operator | admin
    "risk": "low",                             // low | medium | high
    "scope": "server"
  }],
  "widgets": [ { "type": "hello_host", "display_name": "Hello Host", "...": "..." } ]
}
```

Each widget has the fields of the Add Widget picker (`display_name`, `description`, `icon`, `category`,
`default_size`, `min_size`, `refresh_interval`, `supports_linux`, `supports_windows`), `config_schema` (the
settings a person fills in when adding it) and a `spec`.

## 2. Write the scripts

A script is a plain file per platform. It prints what it found; it never receives anything as part of its
text. Values the person chose arrive as **parameters**, in the environment: `BOSUN_PARAM_<name>` (and all of them as
JSON in `BOSUN_PARAMS`).

```sh
#!/bin/sh
host=$(hostname)
up=$(uptime -p 2>/dev/null || uptime)
printf '{"message":"%s, %s","uptime":"%s"}\n' "$BOSUN_PARAM_greeting" "$host" "$up"
```

Declare each script in the spec with the account it runs as, its timeout and its parameters. Every string
parameter needs an anchored `pattern` (or a fixed list of `values`), every number a `min` and `max`; Bosun checks
the value before the script ever starts.

```jsonc
"scripts": {
  "hello": {
    "as": "shell",                             // "shell": non-admin account; "service": the privileged account
    "timeoutSec": 15,
    "linux": "scripts/hello.sh",
    "windows": "scripts/hello.ps1",            // leave out to make the widget Linux-only
    "params": { "greeting": { "type": "string", "pattern": "^[A-Za-z ,!.-]{1,40}$", "maxLength": 40, "default": "Hello" } }
  }
}
```

Scripts can also print `PROGRESS`, `DONE` and `ERROR:` lines to report progress or fail with a message; a
long running script can be declared a `job` that the screen follows (see `widgets/ollama` for installs and
updates, and `widgets/docker` for a terminal action).

## 3. Say where the data comes from and how it looks

```jsonc
"data": {
  "source": "command", "as": "shell", "command": "",
  "script": "hello",
  "args": { "greeting": "config.greeting" },   // parameter <- widget setting
  "parse": "json",                             // json | jsonlines | lines | text
  "cacheSec": 30, "timeoutSec": 15,
  "permission": "hello_host.view"              // required: who may see the widget and its data
},
"view": {
  "type": "fields",
  "fields": [ { "label": "Message", "value": "{message}" }, { "label": "Up", "value": "{uptime}" } ]
}
```

The `data` can also read what Bosun's collectors already gather (`"source": "snapshot"`, with a `section`) so a
widget that only shows CPU, disks or services needs no script at all. Views are `list`, `table`, `fields`, `text`,
`chart`, or a `layout` of blocks (sections, key/value lists, buttons, forms, notices, job progress). Actions
(`actions`) run a script on a row or from a button, each with its own permission; `state` probes and `lookups`
(plain HTTPS GETs of hosts the manifest lists under `network`) fill the screen with facts about the host.
`widgets/README.md` lists every part of the spec.

## 4. Settings that need a permission

A setting that changes what runs on the host should say so: add `"requires_permission": "<your.permission>"` to
its `config_schema` entry. Bosun then refuses to save a value from anybody who does not hold that permission,
in the widget's settings and through the API.

## 5. Install and try it

1. Zip the folder (`manifest.json` at the top, or inside one folder) and import it in **Settings → Widgets**,
   or push it to a branch of a GitHub repository and install it from there.
2. Bosun shows every script, the account it runs as and the permissions it adds, and asks to confirm.
3. Add the widget to a dashboard. Grant the permissions you declared to the groups that should have them.

The scripts are stored in Bosun's database and written to each host that needs them when the widget runs, so one
package works on every node of a cluster. Upgrading is installing a higher `version`.

## Rules Bosun keeps for you

- The package id and widget types cannot clash with Bosun's own; permission ids start with the package id.
- A package cannot grant itself a stronger built-in permission.
- A widget is hidden from everybody who lacks its data permission for that server.
- Parameters are validated and passed as data, never spliced into a script.
- Nothing in Bosun's own code names a widget type, a package id or a package permission. A test
  (`src/lib/widgets/guard-rails.test.ts`) fails when it does; the few legitimate exceptions are listed, with the
  reason, in `src/lib/widgets/guard-rails.allow.json`. If the widget you want needs something Bosun cannot do
  for any package, add a **generic** capability to the runtime, not a special case for your widget.

## Bigger widgets: screens, datasets, menu entries and secrets

A widget can have more than its small view. All of this is declared in the spec (version 2) and the package's scripts; Bosun has no
code for any particular widget. The Docker package (`widgets/docker`) uses every part of it; read its manifest next to this section.

```jsonc
"datasets": {                                  // read-only scripts a screen loads when it opens
  "images": { "script": "images", "cacheSec": 5, "permission": "docker.view" }
},
"screens": {
  "create": {
    "kind": "dialog",                          // a pop-up ("page" = a full page at /widgets/<widget id>/<screen id>)
    "title": "New container", "size": "xl",    // md | lg | xl
    "load": { "networks": { "dataset": "networks", "args": {} } },     // datasets.networks in the blocks below
    "blocks": [ { "type": "editor", "param": "settings", "fields": [ ... ], "submits": [ { "action": "create", "label": "Create" } ] } ]
  }
},
"menu": [ { "id": "new", "label": "New container", "icon": "plus", "screen": "create", "permission": "docker.manage" } ],
"actions": [ { "id": "edit", "label": "Edit", "icon": "pencil", "kind": "screen", "screen": "edit", "permission": "docker.manage" } ]
```

- **Screens** are made of the layout blocks (`section`, `kv`, `notice`, `buttons`, `form`, `view` for tables and lists) plus `tabs` and
  `editor`. A screen opened by a row action (`"kind": "screen"`) gets that row as `context`, and a `load` entry can pass fields of it to a
  dataset (`"args": { "name": "context.name" }`). A `view` block reads a list with `"path": "datasets.images"`.
- **Datasets** run one of the package's scripts as the account it declares, with the usual parameter rules, and must print one JSON
  document. They need a permission of the package and are cached for `cacheSec`. They run when a person opens the screen (over the
  shared connection of the host), never in the background.
- **The editor** block has fields `text`, `number`, `select` (fixed `options` or `optionsFrom` a list in the context), `checkbox`,
  `textarea`, `lines` (a list of values), `pairs` (a list of name and value) and `heading`. Each field has an optional `when` over
  `values.<field>`, a `warn` text for risky fields, and `required`. A submit calls an action; the fields reach it either as one
  **`text` parameter** (`"param": "settings"`: a line `key=value` per setting, repeated keys for lists) or one by one
  (`"params": { "name": "values.name" }`). A `text` parameter may hold several lines (`maxLength`, `maxLines`, and a `linePattern`
  every line must match); the script parses it as data and must never paste it into a command.
- **Secrets**: declare `"secrets": [{ "id": "git_token", "label": "GitHub access token" }]` in the manifest and name the ones a script
  needs (`"secrets": ["git_token"]` on the script, Linux only). An admin sets them under Settings, Widgets (key icon); they are
  stored encrypted, never shown again, and reach only that script, as `BOSUN_SECRET_git_token`, at the top of the script text on stdin
  (so not on the command line). Output is scrubbed of their values.

### More of the editor, and tasks

- **Rows** (`"input": "rows"`): a list whose rows have labelled boxes (`columns`: text, number or a drop-down). `format` says how a row is written as one
  line of the settings (`{ "col": "host_port", "suffix": ":" }`, fixed text with `{ "lit": "svc." }`, `optional`, `omit`), `parse` is the anchored regular
  expression with a named group per column that reads a stored line back, and `derive` fills a column from another one after parsing. The Docker package
  uses it for ports (host address, host port, container port, protocol) and volumes (volume or folder, source, path, read only).
- **Options from the host**: a `select` (or a rows field, for its select columns marked `"remote": true`) with `"remote": { "dataset", "args", "path", "value" }`
  asks one of the package's datasets while the form is open, with arguments from other fields (`"values.repo"`), and shows the answer as its options. `"custom":
  "Custom…"` adds an entry that lets the person type a value, which is also what the field becomes when the host finds nothing.
- **Buttons that fill the form**: `{ "input": "button", "tool": { "dataset", "args" } }` calls a dataset and applies its answer
  `{ "fill": { "<field key>": value }, "errors": [], "notes": [] }` to the fields. A list or rows field takes lines, a checkbox "true" or "false". Errors are shown in
  red under the button and say what could not be converted. Use `"transient": true` on a box that only feeds a button (the pasted text), and a heading with
  `"collapsed": true` to hide the fields below it until the person opens it.
- **Text areas** take `"height"` (lines) and `"upload": true` (a file is read into the box). A `code` block shows text from the context with Copy and Download.
- **Secrets in a list**: `"mask": "secret-names"` on a `pairs` or text area of `KEY=value` lines hides the values of names such as PASSWORD or TOKEN, and keeps them
  out of logs.
- **Errors** of an action started from an editor are shown in the pop-up itself, under the buttons.
- **Tasks**: an action with `"job": true` runs in the background and appears in the notification area at the top of Bosun with its steps, its log and, when
  it was started from an editor, "Open the screen": the screen comes back with what was filled in, to correct it and try again. Values the editor marks with
  `mask` are kept encrypted on the server and never sent back to the browser (it only gets a placeholder that the server turns into the real value when the
  form is submitted again); logs never contain them. Different actions can run at the same time; the same action only once per widget and server.
