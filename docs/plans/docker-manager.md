# Docker manager (the Docker widget package, version 2)

Goal: a Portainer-like Docker manager that lives entirely in `widgets/docker` (scripts, settings, permissions, screens). Bosun's
core gets only the **generic** capabilities any package may use (decided with the owner on 2026-10-31):

- package-declared **menu entries** in a widget's ⋮ menu (New container, Manage)
- package-declared **screens**: a `dialog` (pop-up) or a `page` (full page, opened from a menu entry), built from the layout blocks
  plus `tabs` and a rich `editor` block (text, number, select, checkbox, text area, list of lines, key=value rows)
- row actions of kind `screen` (the edit icon of a container opens the edit dialog with that row's values)
- **datasets**: named, parameterised, read-only scripts a screen loads on demand (images, volumes, networks, inspect of one container)
- a multi-line **`text` parameter** for scripts (a settings blob, a compose file)
- package **secrets** (a GitHub token), stored encrypted, handed only to scripts that declare them

Owner decisions: risky container options (privileged, host namespaces, Docker socket or host-path mounts, extra capabilities,
devices) are allowed with a warning and a separate permission (`docker.privileged`, admin by default); private GitHub repos are
supported with an access token; the work lands directly on `dev`.

## Scripts (Linux, POSIX sh, run as the service account; Windows hosts are not supported by the Docker package)

Every script is a file `widgets/docker/scripts/<name>.sh`. Parameters arrive as `BOSUN_PARAM_<name>` environment variables.
Output protocol (see `parseScriptOutput`): a **dataset** script prints one JSON document and nothing else; an **action** script
prints progress lines `PROGRESS n/m` and ends with `DONE <message>` or `ERROR: <message>`.

Never use `eval`, never paste a parameter into a command line as text: build argument lists with `set -- "$@" ...` and pass
`"$@"`. Everything a person typed is data.

### The settings blob (`settings` parameter, type `text`)

One setting per line, `key=value` (the value is everything after the first `=`; no quotes needed). Keys marked * may repeat.
Lines are at most 1000 characters; a blank line and a line starting with `#` are ignored. Unknown keys are refused.

| key | meaning |
| --- | --- |
| `name` | container name (`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`) |
| `image` | image reference (required for create; recreate keeps the current one when absent) |
| `cmd`* | one argument of the command per line (order kept); none = the image's command |
| `entrypoint`* | one argument of the entrypoint per line; `entrypoint=` alone (empty value) clears it |
| `env`* | `KEY=value` |
| `port`* | `[hostip:]hostport:containerport[/tcp\|udp]` |
| `volume`* | `source:target[:ro]` (source is a volume name or an absolute host path) |
| `tmpfs`* | target path |
| `label`* | `key=value` |
| `network` | network name (`bridge`, `host`, `none`, or a user network) |
| `network_alias`* | alias on that network |
| `restart` | `no`, `always`, `unless-stopped`, `on-failure`, or `on-failure:N` |
| `hostname`, `user`, `workdir` | as in `docker run` |
| `memory` | e.g. `512m`, `2g` (a plain number is MB); empty = unlimited |
| `cpus` | decimal, e.g. `1.5`; empty = unlimited |
| `dns`*, `add_host`* | as in `docker run` (`--dns`, `--add-host host:ip`) |
| `log_driver`, `log_opt`* | `--log-driver`, `--log-opt key=value` |
| `stop_signal`, `stop_timeout` | |
| `tty`, `interactive`, `init`, `read_only` | `true` / `false` |
| `health_cmd`, `health_interval`, `health_timeout`, `health_retries` | healthcheck |
| **risky** `privileged` | `true` |
| **risky** `pid`, `ipc` | `host` |
| **risky** `cap_add`*, `cap_drop`* | capability names (cap_drop is safe; only cap_add is risky) |
| **risky** `device`* | `/dev/x[:/dev/y[:rwm]]` |
| **risky** `security_opt`* | e.g. `seccomp=unconfined` |
| **risky** `sysctl`* | `key=value` |
| `gpus` | `all` or a count (needs the NVIDIA runtime) |

A setting is **risky** when it is one of the **risky** keys above, when `network=host`, or when a `volume` source is
`/var/run/docker.sock`, `/`, `/etc*`, `/root*`, `/home/*/.ssh*`, `/proc*`, `/sys*`, `/boot*`, `/usr*`, `/var/lib/docker*`
(after removing `..` segments), or any `containerd.sock`. The scripts refuse risky settings unless the parameter `allow_risky`
is `true`; only the action variant guarded by the permission `docker.privileged` passes it. The refusal message lists what is
risky ("needs the permission to use elevated container options: privileged, host path /etc").

### Datasets (read-only, JSON on stdout, `as: service`)

| script | params | output |
| --- | --- | --- |
| `inspect` | `name` | `{"name","image","state","settings":{...every key above in the form a person edits: scalars as strings, repeated keys as arrays of strings...},"risky":[...reasons...],"readonly_note":"settings Bosun cannot show (kept as they are is NOT possible: see below)"}` |
| `images` | none | array of `{"id","repo","tag","ref","size","created","containers":N,"dangling":bool}` |
| `volumes` | none | array of `{"name","driver","mountpoint","size","containers":N,"created"}` (size from `docker system df -v`, may be empty) |
| `networks` | none | array of `{"id","name","driver","scope","subnet","gateway","containers":N,"internal":bool}` |
| `system` | none | `{"version","containers":{"total","running","paused","stopped"},"images":N,"disk":{"images","containers","volumes","cache"},"compose":bool}` |
| `stacks` | none | array of `{"name","status","services":N,"source":"editor\|git\|external","repo","branch","file","updated"}` (compose projects: `docker compose ls -a --format json` merged with Bosun's own records) |
| `stack_get` | `name` | `{"name","source","repo","branch","file","yaml","env"}` (the stored compose file and .env text of a Bosun-managed stack) |
| `container_logs` is NOT a dataset: it stays an action with `result: text`. | | |

Recreate semantic (`recreate`): read the container with `docker inspect`, rename it `<name>-bosun-old`, create and start the new one
with the full settings blob, and on any failure remove the new one and restore the old (rename back, start if it was running).
Remove the old container only when the new one is running. Settings Bosun does not manage (see "Preserved settings") are copied from
the old container so an edit never silently drops them.

Preserved settings (copied by `recreate`, not editable): labels starting with `com.docker.compose.` (keeps stack membership),
`--device-cgroup-rule`, `--ulimit`, `--shm-size`, `--group-add`, `--oom-score-adj`, `--mac-address`, `--ip`, `--ip6`, `--cgroup-parent`,
`--runtime`, `--stop-signal`, `--storage-opt`. The inspect output lists them under `"preserved"` so the dialog can say what stays.

### Actions (write)

| script | params | does |
| --- | --- | --- |
| `container_create` | `settings` (text), `allow_risky` (bool, default false) | pull the image when missing (progress lines), create, start; prints `DONE created <name>` |
| `container_recreate` | `name`, `settings`, `allow_risky` | see above |
| `container_remove` | `name`, `volumes` (bool) | `docker rm -f` (and anonymous volumes when asked) |
| `image_pull` | `ref` | pull with progress |
| `image_remove` | `ref`, `force` | |
| `image_prune` | `all` (bool) | |
| `volume_create` | `name`, `driver` | |
| `volume_remove` | `name` | |
| `volume_prune` | none | |
| `network_create` | `name`, `driver`, `subnet` (optional), `gateway` (optional) | |
| `network_remove` | `name` | |
| `network_prune` | none | |
| `stack_deploy` | `name`, `source` (`editor`\|`git`), `yaml` (text, editor), `env` (text, `.env` lines), `repo`, `branch`, `file`, `pull` (bool) | store under `$HOME/bosun-stacks/<name>/`, `docker compose -p <name> up -d --remove-orphans`; git source clones/updates over https using `BOSUN_SECRET_git_token` when set (as an `http.extraHeader` Basic auth via `GIT_CONFIG_*` environment, never on the command line or in the URL) |
| `stack_action` | `name`, `op` (`up`,`down`,`restart`,`pull`,`stop`,`start`) | `docker compose -p <name> ...` in the stack's folder |
| `stack_remove` | `name`, `volumes` (bool) | `down` then delete the folder |

Risky detection for stacks: `stack_deploy` runs `docker compose config --format json` and applies the same risky rules to every
service (`privileged`, `network_mode: host`, `pid: host`, `cap_add`, `devices`, host-path or socket `volumes`); same
`allow_risky` rule.

## Permissions of the package

`docker.view` (see containers, viewer), `docker.logs`, `docker.control` (start/stop/restart; operator), `docker.shell`,
`docker.manage` (edit and create containers, images, volumes, networks, stacks; admin), `docker.privileged` (risky options; admin,
high risk), `docker.delete` (remove containers/images/volumes/networks/stacks and prune; admin, high risk).
