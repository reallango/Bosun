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

## Status (2026-10-31)

**Built** (package `docker` 1.0.2, all in `widgets/docker`; the generic pieces in core are listed at the top):

- container list with an edit icon; ⋮ menu: New container, New stack, Manage
- edit dialog: every standard setting, loaded from `docker inspect`; saving replaces the container (rename, create, stop old, start new, roll back on failure)
- New container dialog (pulls a missing image); Run on an image of the Images tab opens it with the image filled in
- stacks: editor (compose file + .env) or a GitHub repository (branch, compose file, optional token as a package secret); edit, start, stop, restart, pull and redeploy, remove
- Manage page: Overview, Containers, Images (pull, run, remove, prune), Volumes, Networks, Stacks
- risky options need `docker.privileged`; removing and pruning need `docker.delete`; reading a container's settings needs `docker.manage`

**Verified** on a throwaway Docker daemon (docker-in-docker, private network): edit (env changed, ports, network, volume and labels kept), New container from the dialog, risky refusal for the plain action and success for the privileged one, a value that looks like shell code stored literally, a stack from the editor with a .env file, the stack editor prefilled, a viewer refused every manage action and dataset. The scripts were also run against the nuc's real Docker (only throwaway `bsbt-*` objects).

**Not verified yet / known gaps**

- a successful deploy from a GitHub repository and a real token (the clone, risky check and rollback were exercised; no suitable public compose file without ports was found)
- the prune actions (only against a fake Docker), the Windows host case (the package is Linux only)
- "Create from a docker run command" is not built; the Run button on an image and the New container dialog cover creating from a GUI
- not kept when a container is edited: MAC address, networks beyond the first, links, volumes-from, cpu-shares (the dialog says what applies)
- tables and the overview on the Manage page use the small widget text size

## Round 2 (owner feedback, 2026-10-31): script contract

New and changed scripts in `widgets/docker/scripts/` (same house rules as before: POSIX sh, no eval, parameters are data, `ERROR:` + exit 0 for actions, datasets print one JSON document):

**Bug 11 (the NPM log error)** `logs.sh`: a container's own log line that starts with `ERROR:`, `DONE` or `PROGRESS` was read as the script output protocol, so reading the log of a container that failed showed an error instead of its log. Neutralise every output line that starts with `ERROR:`, `DONE` or `PROGRESS` by putting one space in front of it. (Check the other scripts that print container-controlled text, e.g. `control.sh`, `image_pull.sh`, `stack_*`; use the same rule or print it so it cannot be mistaken for the protocol.)

**Datasets** (read-only; all need `docker.manage` except where noted; all print `{"fill":...,"errors":[...],"notes":[...]}` or the shape given):

- `export_run` `{name}` -> `{"text": "<a docker run command, one option per line joined with \ line continuations>"}`: the container's settings (the same ones `inspect.sh` knows, including the preserved ones where a docker run flag exists) as a `docker run -d` command. Quote values safely for a POSIX shell. Secrets are NOT removed (the person exports their own container; the dialog says so).
- `export_compose` `{name}` -> `{"text": "<a compose file>"}` with one service named after the container (`services:\n  name:\n    image: ...`), ports, volumes (named volumes also under a top-level `volumes:` with `external: true`... if the volume exists, else plain), networks (top-level `networks:` with `external: true` for non-default networks), environment, labels, restart, command, entrypoint, user, working_dir, hostname, mem_limit, cpus, dns, extra_hosts, logging, stop_signal, stop_grace_period, tty, stdin_open, init, read_only, healthcheck, privileged, pid, ipc, cap_add, cap_drop, devices, security_opt, sysctls.
- `convert` `{input: text (<=65536 chars, <=2000 lines)}` -> `{"fill":{<settings key>: string | [strings] },"errors":[...],"notes":[...]}`: `fill` uses exactly the keys of the settings table in this document (booleans as "true"/"false", repeated keys as arrays). Detect the input: a `docker run` / `docker container run` / `docker create` command (the leading word, optionally prefixed with `sudo`; line continuations `\` and `^`; quotes, `$VAR` is NOT expanded, `$(...)` is refused) or a compose file (contains `services:`). A command: map every flag it knows (-d, --name, -p/--publish, -v/--volume, --mount (type=bind|volume|tmpfs, source/src, target/dst/destination, readonly/ro), -e/--env, --env-file (error: file not available), -l/--label, --network/--net, --network-alias, --restart, -h/--hostname, -u/--user, -w/--workdir, -m/--memory, --cpus, --dns, --add-host, --log-driver, --log-opt, --stop-signal, --stop-timeout, -t/--tty, -i/--interactive, --init, --read-only, --health-*, --privileged, --pid, --ipc, --cap-add, --cap-drop, --device, --security-opt, --sysctl, --tmpfs, --gpus, --entrypoint, then image, then the command arguments) in both `--flag value` and `--flag=value` forms and combined short flags (`-dit`). Flags that are accepted but meaningless for the editor (`--rm`, `-d`, `--detach`, `--pull`, `--platform`... decide per flag) go to `notes`; flags you do not know go to `errors` as "Not converted: --flag value (reason)". A compose file: use `docker compose -f <temp file> config --format json` on the host to resolve it (a temp dir that is removed afterwards; if compose fails, put its message in `errors`); one service only (several: convert the first, note the others by name); map its fields to the settings keys; build/depends_on/secrets/configs/profiles/deploy... that cannot be expressed go to `errors`. Never run the command; never execute anything from the input.
- `exposed_ports` `{ref}` -> `{"fill":{"port":["49321:80/tcp","49322:443/tcp"]},"errors":[],"notes":["The image exposes 80/tcp, 443/tcp"]}`: the ports the image declares (`docker image inspect`; pull the image first when it is missing, with a clear error if that fails) each mapped to a random host port in 49152-65535 that is free on the host (not listening: check with `ss -ltnu`/`netstat` when available, and not published by any container (`docker ps` ports), and not chosen twice). No exposed ports: `fill.port` is `[]` and a note says so.
- `git_branches` `{repo}` -> `{"items":[{"name":"main","default":true},{"name":"dev","default":false}]}` (`git ls-remote --symref --heads`; default branch first; same https/host/token rules as `stack_deploy`; uses `BOSUN_SECRET_git_token` for github.com only).
- `git_files` `{repo, branch}` -> `{"items":["docker-compose.yml","deploy/compose.yaml"]}`: shallow single-branch clone into a temp dir (removed afterwards), then the compose files found up to 3 folders deep (names `docker-compose*.yml|yaml`, `compose*.yml|yaml`), ignoring `.git` and `node_modules`, root first, then alphabetical.
- `git_services` `{repo, branch, file}` -> `{"services":[{"name":"web","container_name":"","image":"nginx","ports":["8080:80/tcp"],"volumes":["./data:/data"],"networks":["default"]}],"networks":["default","backend"]}` (clone as above; `docker compose -f file config --format json`; missing required variables must not stop it: report them in `"warnings"`).
- `system` gets `"drivers":{"volume":["local",...],"network":["bridge","host","overlay","macvlan","ipvlan","null"...]}` from `docker info`.

**Actions**

- `stack_deploy` gets a new text parameter `override` (default ''): lines `svc.<service>.<key>=<value>` with key `container_name` (one), `port`, `volume`, `network` (repeatable; each list REPLACES the one in the compose file for that service). The script writes `compose.override.yaml` next to the compose file (`!override` tags; needs Docker Compose >= 2.24, check `docker compose version --short` and give a clear `ERROR:` otherwise), passes `-f compose.yaml -f compose.override.yaml` (or for a git source `-f repo/<file> -f compose.override.yaml` using `--project-directory`), applies the risky check to the MERGED config, stores `override` under the stack folder, and `stack_get` returns it as `"override"` (a string). No override lines: no override file, and any old one is removed.
- `image_prune` already accepts `all=true` (remove every unused image, not only dangling ones): make its output say what was removed and how much space was reclaimed (`DONE removed 4 images, reclaimed 1.2GB`).
- Progress: `container_create`, `container_recreate`, `image_pull`, `stack_deploy`, `stack_action`, `stack_remove`, `container_remove` print short human step lines as they work (a plain line such as `Pulling nginx:alpine` is a step the job shows), and a `DONE <what happened>` at the end.

## Status, round 2 (2026-10-31)

Built from the owner's feedback list and verified in the browser against a throwaway Docker-in-Docker host: errors inside the pop-up; GitHub branch and compose-file drop-downs with Custom; service overrides (container name, port, volume, network); a four times taller compose editor with upload; driver drop-downs; import from a `docker run` command or compose file; export of a container as `docker run` or compose; ports and volumes as labelled boxes with "Publish all exposed ports"; both prune choices (dangling, all unused); the NPM log bug (a log line starting with `ERROR:` was read as the script protocol); tasks in the notification bell with log and "Open the screen" (secrets masked, kept encrypted on the server, resolved there on resubmit). Text parameters now travel on stdin with the script (size limit, process list).

Not verified live: a successful stack deploy from GitHub (with an override, with a token), Docker Compose older than 2.24 (overrides), the prune actions against a real Docker, Windows.
Known limits: one running job per action, widget and server; the editor's export shows the saved container, not unsaved edits.
