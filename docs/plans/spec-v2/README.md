# Widget spec version 2 (reference and drafts)

Version 2 lets a package carry a whole widget, logic and screens, so that nothing about it is built into Bosun. See
`../widget-self-containment.md` for the why and the phases. The validators are `src/lib/widgets/runtime/spec.ts`
(version 1 and the shared parts) and `spec-v2.ts` (the additions); `spec-v2.test.ts` loads the packages in
`widgets/` and is the executable specification.

The three packages `widgets/ollama`, `widgets/updates` and `widgets/commands` are the worked examples: complete
version 2 packages with their scripts for each platform, checked by the tests next to them.

## What version 2 adds

| Key | Meaning |
| --- | --- |
| `scripts` | Host scripts: `{ as: service or shell, timeoutSec, linux: "scripts/x.sh", windows: "scripts/x.ps1", params }`. A script has a file per platform it supports and strictly typed parameters (anchored pattern or fixed values, numbers with a range). Parameters reach the script as data, never as part of its text. |
| `state` | `{ script, periodSec, initialDelaySec, fields }`: a parameterless script the poller runs on the host now and then. Its `dotted.key=value` lines become the widget's `state` object, typed by `fields`. |
| `lookups` | `{ url, path, match, ttlSec }`: an HTTPS GET of a fixed URL on a host the manifest lists under `network`; the value at `path` (optionally the one capture group of `match`) is available as `lookups.<id>`. Never an IP address, port or credentials. |
| `data.script` | Data produced by a script. `args` maps its parameters to instance settings (`config.<key>`); `cacheSec` may be up to 24 h, `timeoutSec` up to 15 min, `initialDelaySec` delays the first run, `cacheSecFrom: "config.interval"` takes the interval from a setting. |
| actions `kind: "script"` | `variants`: the first whose `when` holds runs. `args` maps script parameters to `param.<action parameter>`, a path into the context, or `literal:<text>`. `job: true` runs it as a long-running job. `stores: "data"` makes its output the widget's stored data ("check now"). `confirm.requireText` makes the person type a value. |
| view `layout` | `blocks`: `section` (collapsible, `defaultOpen`, `badges` with conditions, `summary`), `kv`, `text`, `notice`, `buttons`, `form`, `select`, `jobProgress`, and `view` (any version 1 view over the widget's data, optionally at a `path`). |
| conditions | `all`, `any`, `not`, and `gt`, `gte`, `lt`, `lte`, `newerThan` (a version at `field` newer than the version at the named path) next to `equals`, `notEquals`, `in`, `exists`. |
| `metrics[].from.path` | Count or aggregate the list at a path inside object-shaped data. |
| manifest `network` | Hosts the package's lookups may contact (shown at install, enforced at run time). |
| settings field `requires_permission` | Changing that instance setting needs a permission the package declares (for example the command of a Custom Command). |

## The context

Conditions, templates and arguments read a context with these roots:

- `state` the state probe's object, `data` the widget's data, `config` the widget's instance settings,
  `lookups` the lookup values, `job` the current job (`status`, `steps`, `percent`, `message`),
  `server` the server (`platform`, `name`, `hostname`), `param` the parameters of an action being run.
- A row of a list or table is the root inside that view (version 1 behaviour, unchanged).

## Script output protocol (generic)

A script prints lines that Bosun understands without knowing what the widget is: `[step] text` for progress,
`PROGRESS done/total` for a percentage, `DONE <text>` on success, `ERROR: <text>` on failure; the exit code counts as
usual. A state probe prints `dotted.key=value` lines. A data script prints what `data.parse` says (JSON, lines, text).

## Rules that keep a package from becoming arbitrary code

- Nothing a package ships runs inside Bosun or the browser. Everything done to a host is one of its reviewed scripts,
  as the account the script declares; the install review lists every script with its account and hash.
- Every action names a permission the package declares; the data permission decides who sees the widget.
- Script parameters are validated twice (when the package is installed and when an action is called) and are passed as
  data. Lookups may only contact the hosts the manifest lists, over HTTPS.
- The browser receives the layout and the conditions of the variants, never the scripts, the arguments, the state
  probe or the lookups.
