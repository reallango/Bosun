#!/bin/sh
# Docker (Linux): runs one operation on a compose stack: up, down, restart, pull, stop or start (`docker compose -p <name> ...`
# with the stack's stored files from $HOME/bosun-stacks/<name>/). A stack Bosun did not create (external) can only be
# stopped, started, restarted or taken down (docker compose finds its containers by label); up and pull need the stored files.
# `update` re-fetches a git stack's branch, rebuilds and starts it with the stored .env and override (nothing is re-entered).
# The fetched version is checked for risky options exactly like a deployment (stack_deploy.sh): without allow_risky (the
# docker.privileged variant) an update that adds privileged mode, host namespaces, devices, the Docker socket or sensitive
# host folders is refused and the checkout goes back to the version that was running.
# Parameters: name, op, allow_risky.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
# >>> git credentials (the same text in stack_deploy.sh, stack_action.sh, git_branches.sh, git_files.sh and git_services.sh; a test compares them)
# Bosun resolves the Git credential entry for this repository before the script runs: the entry of the host with the longest
# matching owner/repository scope, limited to the servers it is allowed on. Only that entry's fields arrive, as
# BOSUN_CRED_GIT_HOST, _SCOPE, _USERNAME and _TOKEN. They are taken out of the environment at once, so git, docker and compose
# never inherit them. git_auth <https url> sets AUTH to the Basic Authorization header for exactly that repository's host, or ''
# when the entry is for another host; it reaches git only through gitrun's environment.
GIT_HOST=${BOSUN_CRED_GIT_HOST-}; GIT_USER=${BOSUN_CRED_GIT_USERNAME-}; GIT_TOKEN=${BOSUN_CRED_GIT_TOKEN-}
# Bosun picks the entry with a case-insensitive host, so the comparison below must be case-insensitive too.
GIT_HOST=$(printf '%s' "$GIT_HOST" | tr 'A-Z' 'a-z')
unset BOSUN_CRED_GIT_HOST BOSUN_CRED_GIT_SCOPE BOSUN_CRED_GIT_USERNAME BOSUN_CRED_GIT_TOKEN
git_auth() {
  AUTH=''
  gh=${1#https://}; gh=${gh%%/*}; gh=$(printf '%s' "$gh" | tr 'A-Z' 'a-z')
  cred=$GIT_TOKEN
  [ -z "$cred" ] || [ -z "$GIT_HOST" ] || [ "$GIT_HOST" = "$gh" ] || cred=''
  [ -n "$cred" ] || return 0
  case "$cred" in *[!A-Za-z0-9_.~+/=:@-]*) cred=''; fail 'a Git credential has unexpected characters' ;; esac
  case "$cred" in
    *:*) pair=$cred ;;
    *) u=$GIT_USER; if [ -z "$u" ]; then case "$gh" in github.com) u=x-access-token ;; bitbucket.org) u=x-token-auth ;; *gitlab*) u=oauth2 ;; *) u=git ;; esac; fi; pair="$u:$cred" ;;
  esac
  if command -v base64 >/dev/null 2>&1; then b64=$(printf '%s' "$pair" | base64 | tr -d '\n')
  elif command -v openssl >/dev/null 2>&1; then b64=$(printf '%s' "$pair" | openssl base64 -A)
  else fail 'neither base64 nor openssl is available to prepare the Git credential'; fi
  AUTH="Authorization: Basic $b64"
  cred=''; pair=''; b64=''
}
# <<< git credentials
name=$BOSUN_PARAM_name; op=$BOSUN_PARAM_op
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'invalid stack name' ;; esac
[ "${#name}" -le 63 ] || fail 'invalid stack name'
ht=${BOSUN_PARAM_health_timeout:-180}
case "$ht" in ''|*[!0-9]*) fail 'health_timeout must be a number of seconds' ;; esac
[ "$ht" -le 600 ] || fail 'health_timeout must be at most 600 seconds'
POLL=${BOSUN_UPDATE_POLL:-2}; case "$POLL" in ''|*[!0-9]*) POLL=2 ;; esac
case "$op" in
  up) set -- up -d --remove-orphans ;;
  down) set -- down ;;
  restart) set -- restart ;;
  pull) set -- pull ;;
  update) set -- up -d --build --remove-orphans ;;
  stop) set -- stop ;;
  start) set -- start ;;
  guard_up) set -- up -d --remove-orphans ;;
  retag) ;;
  update_images) ;;
  *) fail 'op must be up, down, restart, pull, update, stop, start, guard_up, retag or update_images' ;;
esac
case "$HOME" in /*) ;; *) fail 'HOME is not set' ;; esac
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
$D compose version >/dev/null 2>&1 || fail 'Docker Compose (the docker compose plugin) is not installed on this host'
DIR="$HOME/bosun-stacks/$name"
meta_get() { [ -f "$DIR/bosun.meta" ] || return 0; while IFS= read -r l; do case "$l" in "$1="*) printf '%s' "${l#*=}"; return 0 ;; esac; done < "$DIR/bosun.meta"; }
CF=''; PD=''; EF=''
if [ -d "$DIR" ]; then
  if [ "$(meta_get source)" = git ]; then
    f=$(meta_get file)
    case "$f" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'the stored stack record is damaged' ;; esac
    CF="$DIR/repo/$f"
  else CF="$DIR/compose.yaml"; fi
  [ -f "$CF" ] || fail "the compose file of the stack $name is missing"
  PD=$(dirname "$CF")
  [ ! -f "$DIR/.env" ] || EF="$DIR/.env"
else
  case "$op" in up|pull|update|guard_up|retag|update_images) fail "the stack $name was not created by Bosun (no stored compose file), so $op is not possible; import it first" ;; esac
fi
errf=$(mktemp) || fail 'cannot create a temporary file'
# One operation per stack at a time: deploy, update, remove and the compose operations all take this lock, so two of them
# never work on the same stack folder at once. A lock left by a process that is gone (a cancelled job) is taken over.
LOCK="$HOME/bosun-stacks/.lock-$name"
mkdir -p "$HOME/bosun-stacks" 2>/dev/null
take_lock() { mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid"; }
if ! take_lock; then
  lp=$(cat "$LOCK/pid" 2>/dev/null); case "$lp" in ''|*[!0-9]*) lp='' ;; esac
  busy="another operation is running on the stack $name; try again when it has finished"
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then fail "$busy"; fi
  # no pid yet: another run may have just taken it, so only a lock older than a minute counts as left over
  if [ -z "$lp" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then fail "$busy"; fi
  rm -rf "$LOCK"; take_lock || fail "$busy"
fi
trap 'rm -f "$errf"; rm -rf "$LOCK"' EXIT
lastline() { tr -d '\r' < "$errf" | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400; }
# the override file of a stack deployed with overrides (ports, volumes, networks, container name) belongs to every operation
OF=''; [ -z "$CF" ] || [ ! -f "$DIR/compose.override.yaml" ] || OF="$DIR/compose.override.yaml"
dc() { # the compose file, the override file when there is one, the .env file when there is one
  if [ -z "$CF" ]; then $D compose -p "$name" "$@"
  elif [ -n "$EF" ] && [ -n "$OF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" -f "$OF" --env-file "$EF" "$@"
  elif [ -n "$EF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" --env-file "$EF" "$@"
  elif [ -n "$OF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" -f "$OF" "$@"
  else $D compose -p "$name" --project-directory "$PD" -f "$CF" "$@"; fi
}

# update_images: pull the images, recreate only the services whose image changed, then wait for each new container to be
# running and (when it defines one) healthy. A failure re-tags the recorded previous image and recreates that service, so the
# stack goes back to what it ran, and the action fails with "rolled back: <reason>". The previous images are never removed.
if [ "$op" = update_images ]; then
  case "$name" in bosun) fail "this is Bosun's own stack; update it from Settings → Updates" ;; esac
  svc=${BOSUN_PARAM_service:--}
  case "$svc" in -) ;; [!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'invalid service name' ;; esac
  [ "${#svc}" -le 63 ] || fail 'invalid service name'
  repo_of() { r=${1%%@*}; case "${r##*/}" in *:*) r=${r%:*} ;; esac; printf '%s' "$r"; }
  if [ "$svc" = "-" ]; then
    services=$(dc config --services 2>"$errf") || fail "the compose file of the stack $name could not be read: $(lastline)"
  else
    services=$svc
  fi
  [ -n "$services" ] || fail "the stack $name has no services"
  tmpd=$(mktemp -d) || fail 'cannot create a temporary folder'
  trap 'rm -f "$errf"; rm -rf "$LOCK" "$tmpd"' EXIT
  : > "$tmpd/rows"
  for s in $services; do
    case "$s" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail "the compose file names an invalid service: $s" ;; esac
    cid=$(dc ps -aq "$s" 2>/dev/null | head -n 1)
    if [ -n "$cid" ]; then
      ref=$($D inspect --type container --format '{{.Config.Image}}' "$cid" 2>/dev/null)
      case "$ref" in ''|*[!A-Za-z0-9._/:@-]*) fail "the image of the service $s could not be read" ;; esac
      case "$(repo_of "$ref")" in bosun|*/bosun) fail "the stack $name runs Bosun itself; update it from Settings → Updates" ;; esac
      prev=$($D inspect --type container --format '{{.Image}}' "$cid" 2>/dev/null)
      case "$prev" in ''|*[!0-9a-zA-Z:]*) fail "the running image id of the service $s could not be read" ;; esac
      printf '%s|%s|%s\n' "$s" "$ref" "$prev" >> "$tmpd/rows"
    fi
  done
  [ -s "$tmpd/rows" ] || fail "the stack $name has no containers to update"
  echo 'PROGRESS 1/4'; echo "[step] Pulling the images of $name"
  dc pull $services >/dev/null 2>"$errf" || fail "pulling the images of $name failed (nothing was changed): $(lastline)"
  changed=''
  while IFS='|' read -r s ref prev; do
    new=$($D image inspect --format '{{.Id}}' "$ref" 2>/dev/null)
    case "$new" in ''|*[!0-9a-zA-Z:]*) fail "the image $ref of the service $s could not be read" ;; esac
    [ "$new" = "$prev" ] || changed="$changed $s"
  done < "$tmpd/rows"
  if [ -z "$changed" ]; then
    echo 'PROGRESS 4/4'; echo "DONE no newer images: $name"; exit 0
  fi
  echo 'PROGRESS 2/4'; echo "[step] Recreating the changed services:$changed"
  dc up -d --no-deps $changed >/dev/null 2>"$errf" || fail "recreating the changed services of $name failed: $(lastline)"
  echo 'PROGRESS 3/4'; echo '[step] Waiting for the updated containers to be healthy'
  why=''
  deadline=$(( $(date +%s) + ht ))
  health_ok() { # $1 = container id, $2 = service name
    sleep "$POLL"
    while :; do
      st=$($D inspect --type container --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null)
      running=${st%% *}; health=${st#* }
      case "$running" in true) ;; *) why="the service $2 is not running"; return 1 ;; esac
      case "$health" in none|healthy) return 0 ;; unhealthy) why="the service $2 is unhealthy"; return 1 ;; esac
      [ "$(date +%s)" -lt "$deadline" ] || { why="the service $2 did not become healthy within ${ht}s"; return 1; }
      sleep "$POLL"
    done
  }
  bad=''
  for s in $changed; do
    cid=$(dc ps -aq "$s" 2>/dev/null | head -n 1)
    if [ -z "$cid" ]; then why="the service $s has no container after the update"; bad=$s; break; fi
    if ! health_ok "$cid" "$s"; then bad=$s; break; fi
  done
  if [ -n "$bad" ]; then
    echo "[step] Rolling back the stack $name"
    for s in $changed; do
      ref=$(awk -F '|' -v s="$s" '$1 == s { print $2; exit }' "$tmpd/rows")
      prev=$(awk -F '|' -v s="$s" '$1 == s { print $3; exit }' "$tmpd/rows")
      [ -n "$ref" ] || continue
      if [ -n "$prev" ]; then $D tag "$prev" "$ref" >/dev/null 2>&1 || true; fi
      dc up -d --force-recreate --no-deps "$s" >/dev/null 2>&1 || true
    done
    fail "rolled back: $why"
  fi
  echo 'PROGRESS 4/4'; echo "DONE updated images: $name"
  exit 0
fi

# ---- risky options (the same check as stack_deploy.sh; keep the two in step) ----
RISKY=''
add_risk() { case "$RISKY" in *"$1"*) ;; *) RISKY="${RISKY:+$RISKY, }$1" ;; esac; }
# >>> risk classification (the same text in container_create.sh, container_recreate.sh, inspect.sh, stack_action.sh and
# stack_deploy.sh; a test compares them)
# Only an added capability outside Docker's default set is elevated, and only a security option that weakens isolation is.
# cap_add: ALL is every capability; cap_drop never is. An option this does not know stays elevated (the safe default).
cap_risky() {
  _cap=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  case "$_cap" in CAP_*) _cap=${_cap#CAP_} ;; esac
  case "$_cap" in ALL) return 0 ;; esac
  for _capd in CHOWN DAC_OVERRIDE FSETID FOWNER MKNOD NET_RAW SETGID SETUID SETFCAP SETPCAP NET_BIND_SERVICE SYS_CHROOT KILL AUDIT_WRITE; do
    [ "$_cap" = "$_capd" ] && return 1
  done
  return 0
}
secopt_risky() {
  _so=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$_so" in
    *=*) _sok=${_so%%=*}; _sov=${_so#*=} ;;
    *:*) _sok=${_so%%:*}; _sov=${_so#*:} ;;
    *) _sok=$_so; _sov='' ;;
  esac
  case "$_sok" in
    seccomp) case "$_sov" in ''|default) return 1 ;; esac; return 0 ;;
    apparmor) case "$_sov" in unconfined) return 0 ;; esac; return 1 ;;
    label) case "$_sov" in disable) return 0 ;; esac; return 1 ;;
    systempaths) case "$_sov" in unconfined) return 0 ;; esac; return 1 ;;
    no-new-privileges) case "$_sov" in false|0|no) return 0 ;; esac; return 1 ;;
    *) return 0 ;;
  esac
}
# <<< risk classification
sensitive() {
  P=$1 awk 'BEGIN {
    n = split(ENVIRON["P"], a, "/"); k = 0
    for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (k > 0) k--; continue } k++; s[k] = a[i] }
    if (k == 0) exit 0
    p = ""; for (i = 1; i <= k; i++) p = p "/" s[i]
    b = tolower(s[k]); if (b ~ /(docker|containerd|crio|podman)\.sock$/) exit 0
    # The folder itself, anything inside it, or a folder that contains it (mounting /var exposes /var/run/docker.sock).
    n = split("/etc /root /proc /sys /dev /boot /usr /bin /sbin /lib /lib32 /lib64 /libx32 /run /var/run /var/lib/docker /var/lib/containerd /var/lib/kubelet /var/spool/cron", r, " ")
    for (i = 1; i <= n; i++) if (p == r[i] || index(p, r[i] "/") == 1 || index(r[i], p "/") == 1) exit 0
    # Home folders: /home, a whole /home/<user>, or anything hidden in one (.ssh, .bashrc, .config ...).
    if (s[1] == "home" && (k <= 2 || substr(s[3], 1, 1) == ".")) exit 0
    exit 1 }'
}
host_path_risk() {
  if sensitive "$1"; then add_risk "host path $1"; return 0; fi
  hp1=$(readlink -f -- "$1" 2>/dev/null)
  if [ -n "$hp1" ] && [ "$hp1" != "$1" ] && sensitive "$hp1"; then add_risk "host path $1 (is $hp1)"; fi
  return 0
}
check_risks() { # $1: the output of `docker compose config --format json`
  found=$(printf '%s\n' "$1" | awk '
  function key(l,   k) { k = l; sub(/^ *"/, "", k); sub(/".*/, "", k); return k }
  function val(l,   s) { s = l; sub(/^[^:]*: */, "", s); sub(/,$/, "", s); return s }
  function unq(s) { if (s ~ /^".*"$/) s = substr(s, 2, length(s) - 2); return s }
  function item(l,   s) { s = l; sub(/^ */, "", s); sub(/,$/, "", s); return unq(s) }
  function shared(v) { v = unq(v); return v ~ /^(container|service):/ }
  BEGIN { sec = ""; arr = "" }
  {
    line = $0; match(line, /^ */); ind = RLENGTH
    if (ind == 2 && line ~ /^  "/) { sec = key(line); arr = ""; next }
    if (sec == "volumes" && ind == 8 && key(line) == "device") { v = unq(val(line)); if (v ~ /^\//) print "PATH " v; next }
    if ((sec == "secrets" || sec == "configs") && ind == 6 && key(line) == "file") { v = unq(val(line)); if (v ~ /^\//) print "PATH " v; next }
    if (sec != "services") next
    if (ind == 4) { arr = ""; next }
    if (ind == 6) {
      if (arr != "" && line ~ /^ *(\]|\}),?$/) { arr = ""; next }
      k = key(line); v = val(line); arr = ""
      if (k == "privileged" && v == "true") print "RISK privileged"
      else if (k == "network_mode" && v == "\"host\"") print "RISK host network"
      else if (k == "network_mode" && shared(v)) print "RISK network of " unq(v)
      else if (k == "pid" && v == "\"host\"") print "RISK host PID namespace"
      else if (k == "pid" && shared(v)) print "RISK PID namespace of " unq(v)
      else if (k == "ipc" && v == "\"host\"") print "RISK host IPC namespace"
      else if (k == "ipc" && shared(v)) print "RISK IPC namespace of " unq(v)
      else if (k == "uts" && v == "\"host\"") print "RISK host UTS namespace"
      else if (k == "userns_mode" && v == "\"host\"") print "RISK host user namespace"
      else if (k == "cgroup" && v == "\"host\"") print "RISK host cgroup namespace"
      else if (k == "cgroup_parent") print "RISK cgroup parent " unq(v)
      else if (k == "runtime") print "RISK runtime " unq(v)
      else if ((k == "cap_add" || k == "devices" || k == "security_opt" || k == "sysctls" || k == "volumes" || k == "volumes_from" || k == "device_cgroup_rules" || k == "build") && line ~ /[\[{]$/) arr = k
      next
    }
    if (arr == "cap_add" && ind == 8) print "CAP " item(line)
    else if (arr == "security_opt" && ind == 8) print "SECOPT " item(line)
    else if (arr == "sysctls" && ind == 8) print "RISK sysctl " key(line)
    else if (arr == "volumes_from" && ind == 8) print "RISK volumes of " item(line)
    else if (arr == "device_cgroup_rules" && ind == 8) print "RISK device rule " item(line)
    else if (arr == "build" && ind == 8) {
      if (key(line) == "context") { v = unq(val(line)); if (v ~ /^\//) print "PATH " v }
      else if (key(line) == "network" && unq(val(line)) == "host") print "RISK host network while building"
      else if (key(line) == "privileged" && val(line) == "true") print "RISK privileged build"
      else if (key(line) == "entitlements") print "RISK build entitlements"
    }
    else if (arr == "devices") {
      if (ind == 8 && line ~ /^ *"/) print "RISK device " item(line)
      else if (ind == 10 && key(line) == "source") print "RISK device " unq(val(line))
    }
    else if (arr == "volumes") {
      if (ind == 8 && line ~ /^ *"/) { s = item(line); sub(/:.*/, "", s); if (s ~ /^\//) print "PATH " s }
      else if (ind == 8 && line ~ /^ *\{/) { vt = ""; vs = "" }
      else if (ind == 10 && key(line) == "type") vt = unq(val(line))
      else if (ind == 10 && key(line) == "source") vs = unq(val(line))
      else if (ind == 8 && line ~ /^ *\},?$/) { if (vt == "bind" && vs != "") print "PATH " vs }
    }
  }')
  while IFS= read -r l; do
    case "$l" in
      'RISK '*) add_risk "${l#RISK }" ;;
      'CAP '*) capv=${l#CAP }; if cap_risky "$capv"; then add_risk "capability $capv"; fi ;;
      'SECOPT '*) secv=${l#SECOPT }; if secopt_risky "$secv"; then add_risk "security option $secv"; fi ;;
      'PATH '*) host_path_risk "${l#PATH }" ;;
    esac
  done <<EOF
$found
EOF
}

# guard_up: hand a stack over from another manager (Portainer) without leaving it stopped. Started in the background on the host,
# it waits (up to 5 minutes) until none of the stack's containers is running (the other manager took it down), then starts it again
# from the stored files. It outlives this SSH session (and the Bosun that asked for it, when the stack is that Bosun itself).
# retag: move one service of a stack to a new image without rewriting its compose file (self-update of Bosun). Pull `image`, tag
# it as `as` (the image name the service runs, e.g. bosun:latest) and re-create only that service in the background, so it
# completes even when the stack is the Bosun that asked. Nothing changes when the pull fails. Once the service runs again on the
# new image, the other images of the pulled image's repository are removed except that image and the one the service ran before
# (one rollback); see clean_images.
clean_images() { # $1: repository of the pulled image, $2: its id, $3: the image the service ran before (may be empty),
                 # $4 and $5: the pulled reference and the name it was tagged as (never removed)
  used=''
  ids=$($D ps -aq --no-trunc 2>/dev/null)
  if [ -n "$ids" ]; then
    used=$(set -f; set -- $ids; set +f; $D inspect --type container --format '{{.Image}}' "$@" 2>/dev/null | tr '\n' ' ')
  fi
  list=$($D image ls --no-trunc --format '{{json .ID}}{{"\t"}}{{json .Repository}}{{"\t"}}{{json .Tag}}' 2>/dev/null)
  [ -n "$list" ] || return 0
  printf '%s\n' "$list" | awk -F '\t' -v repo="$1" -v new="$2" -v prev="$3" -v refs="$4 $5" -v used="$used" '
    function unq(s) { return (s ~ /^".*"$/) ? substr(s, 2, length(s) - 2) : s }
    BEGIN {
      n = split(used, u, " "); for (i = 1; i <= n; i++) keep[u[i]] = 1
      if (new != "") keep[new] = 1; if (prev != "") keep[prev] = 1
      n = split(refs, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") keepref[a[i]] = 1
    }
    NF >= 3 {
      id = unq($1); r = unq($2); t = unq($3)
      if (r != repo || t == "<none>" || keep[id] || keepref[r ":" t]) next
      print r ":" t
    }' | while IFS= read -r ref; do
      [ -n "$ref" ] || continue
      $D image rm "$ref" >/dev/null 2>&1 && echo "[step] Removed image $ref"
    done
}
if [ "$op" = retag ]; then
  img=${BOSUN_PARAM_image-}; as=${BOSUN_PARAM_as-}; svc=${BOSUN_PARAM_service-}
  for v in "$img" "$as"; do
    case "$v" in ''|-*|*[!a-z0-9._/:@-]*) fail 'image: a lower-case image reference (registry/name:tag)' ;; esac
  done
  [ "${#img}" -le 255 ] && [ "${#as}" -le 255 ] || fail 'image: too long'
  case "$svc" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'service: invalid name' ;; esac
  echo "[step] Pulling $img"
  $D pull "$img" >/dev/null 2>"$errf" || fail "pulling $img failed: $(lastline)"
  $D tag "$img" "$as" 2>"$errf" || fail "tagging failed: $(lastline)"
  repo=${img%%@*}; case "${repo##*/}" in *:*) repo=${repo%:*} ;; esac
  newid=$($D image inspect --format '{{.Id}}' "$img" 2>/dev/null)
  previd=''
  cid=$(dc ps -aq "$svc" 2>/dev/null | head -n 1)
  [ -z "$cid" ] || previd=$($D inspect --type container --format '{{.Image}}' "$cid" 2>/dev/null)
  echo "[step] Re-creating $svc of $name with $img"
  # Fully detached (no stdin, stdout or stderr kept): the SSH session, and so this action, must end now. On the node whose
  # Bosun asked, the answer has to arrive before the re-creation restarts that Bosun (self-update records it).
  (
    trap '' HUP PIPE
    sleep 2
    if dc up -d --no-build --no-deps "$svc"; then
      [ -z "$newid" ] || clean_images "$repo" "$newid" "$previd" "$img" "$as"
    fi
  ) </dev/null >/dev/null 2>&1 &
  echo "DONE retag: $name $svc -> $img"
  exit 0
fi
if [ "$op" = guard_up ]; then
  (
    trap '' HUP
    i=0
    while [ "$i" -lt 300 ]; do
      [ -z "$($D ps -q --filter "label=com.docker.compose.project=$name" --filter status=running 2>/dev/null)" ] && break
      sleep 1; i=$((i + 1))
    done
    sleep 2
    dc "$@"
  ) </dev/null >/dev/null 2>&1 &
  echo "DONE guard_up: $name"
  exit 0
fi
prev=''
echo 'PROGRESS 0/1'; echo "[step] Running docker compose $op for the stack $name"
# update: fetch the stored branch of a git stack (with the stored credential for its host, if any), then rebuild and start with the
# stored .env and override, so nothing has to be entered again.
if [ "$op" = update ] && [ "$(meta_get source)" = git ]; then
  ub=$(meta_get branch)
  case "$ub" in ''|*[!A-Za-z0-9._/-]*) fail 'the stored stack record is damaged' ;; esac
  command -v git >/dev/null 2>&1 || fail 'git is not installed on this host'
  [ -d "$DIR/repo/.git" ] || fail "the stored checkout of the stack $name is missing"
  prev=$(git -C "$DIR/repo" rev-parse HEAD 2>/dev/null) || fail "the stored checkout of the stack $name is damaged"
  echo '[step] Fetching the latest source'
  # the Git access credential Bosun resolved for the stored repository, as for a deployment
  ur=$(meta_get repo)
  case "$ur" in https://*) git_auth "$ur" ;; esac   # (an older record without the address: fetched without a credential)
  ( export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https GIT_LFS_SKIP_SMUDGE=1 GIT_ASKPASS=/bin/true
    if [ -n "$AUTH" ]; then
      export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$AUTH" GIT_CONFIG_KEY_1=http.followRedirects GIT_CONFIG_VALUE_1=false
    fi
    git -c core.hooksPath=/dev/null -C "$DIR/repo" fetch --depth 1 origin "$ub" >/dev/null 2>"$errf" < /dev/null \
      && git -c core.hooksPath=/dev/null -C "$DIR/repo" reset --hard FETCH_HEAD >/dev/null 2>>"$errf" < /dev/null ) \
    || fail "fetching the source failed (for a private repository, add a Git access credential on the Docker widget's Manage page): $(lastline)"
  AUTH=''
  restore() { git -C "$DIR/repo" reset --hard "$prev" >/dev/null 2>&1; }
  [ -f "$CF" ] || { restore; fail "the new version has no $(meta_get file); the stack was left as it was"; }
fi
if [ "$op" = update ]; then
  echo '[step] Checking the compose file'
  cfg=$(dc config --format json 2>"$errf") || { [ -z "$prev" ] || restore; fail "the compose file is not valid: $(lastline)"; }
  check_risks "$cfg"
  if [ -n "$RISKY" ] && [ "$BOSUN_PARAM_allow_risky" != true ]; then
    [ -z "$prev" ] || restore
    fail "the new version needs elevated container options ($RISKY); it was not deployed"
  fi
fi
dc "$@" >/dev/null 2>"$errf"; rc=$?
if [ "$rc" -ne 0 ]; then fail "docker compose $op failed: $(lastline)"; fi
echo 'PROGRESS 1/1'
echo "DONE $op: $name"
exit 0
