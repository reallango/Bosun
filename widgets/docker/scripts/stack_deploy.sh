#!/bin/sh
# Docker (Linux): deploys a compose stack (`docker compose -p <name> up -d --remove-orphans`) and stores its files under
# $HOME/bosun-stacks/<name>/ (compose.yaml, .env, bosun.meta, and repo/ for the git source).
# Parameters: name, source (editor|git), yaml (text, editor), env (text, .env lines, may be empty), repo, branch, file
# (git; "-" or empty = not given), pull (true/false: pull the images before starting).
# Nothing is stored or started before the compose file has been read by `docker compose config` and checked for risky
# options (privileged, host namespaces and network, extra capabilities, devices, security options, sysctls, host-path or socket
# mounts); those need allow_risky=true, which the caller only passes with the elevated permission. For the git source a
# refused or invalid update is rolled back (the previous commit is restored). stack_action only ever runs checked files.
# Git over https only; with BOSUN_SECRET_git_token set (exported by Bosun) it is sent as a Basic Authorization header through the
# environment of the git process only (GIT_CONFIG_*), never on a command line, in a URL, in a file or in the output, and only to
# github.com.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
SECRET_TOKEN=$BOSUN_SECRET_git_token; unset BOSUN_SECRET_git_token   # never let docker, compose or git inherit it by accident
name=$BOSUN_PARAM_name; source=$BOSUN_PARAM_source
repo=$BOSUN_PARAM_repo; branch=$BOSUN_PARAM_branch; file=$BOSUN_PARAM_file
[ "$repo" != - ] || repo=; [ "$branch" != - ] || branch=; [ "$file" != - ] || file=
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'invalid stack name (lower-case letters, digits, - and _; at most 63 characters)' ;; esac
[ "${#name}" -le 63 ] || fail 'invalid stack name (at most 63 characters)'
case "$source" in editor|git) ;; *) fail 'the source must be editor or git' ;; esac
case "$HOME" in /*) ;; *) fail 'HOME is not set' ;; esac

if [ "$source" = editor ]; then
  case "$BOSUN_PARAM_yaml" in *[![:space:]]*) ;; *) fail 'the compose file is empty' ;; esac
else
  case "$repo" in https://*) ;; *) fail 'repo: use an https:// address' ;; esac
  rr=${repo#https://}
  case "$rr" in */*) ;; *) fail 'repo: use https://host/owner/name' ;; esac
  rhost=${rr%%/*}; rpath=${rr#*/}
  case "$rhost" in ''|-*|.*|*[!A-Za-z0-9.-]*|*..*) fail 'repo: invalid host' ;; esac
  case "$rpath" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'repo: invalid path' ;; esac
  [ "${#repo}" -le 300 ] || fail 'repo: too long'
  case "$branch" in ''|-*|*..*|*[!A-Za-z0-9._/-]*) fail 'branch: use letters, digits and . _ / - only' ;; esac
  [ "${#branch}" -le 100 ] || fail 'branch: too long'
  case "$file" in ''|-*|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'file: a relative path inside the repository (letters, digits and . _ / - only)' ;; esac
  [ "${#file}" -le 200 ] || fail 'file: too long'
fi

D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
$D compose version >/dev/null 2>&1 || fail 'Docker Compose (the docker compose plugin) is not installed on this host'
errf=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$errf"' EXIT
lastline() { tr -d '\r' < "$errf" | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400; }

umask 077
nl='
'
DIR="$HOME/bosun-stacks/$name"
NEWDIR=0; [ -d "$DIR" ] || NEWDIR=1
mkdir -p "$DIR" || fail 'cannot create the stack folder'
GITFRESH=0; GITPREV=''
undo() { # a failed or refused deployment leaves the stack as it was
  rm -f "$DIR/compose.yaml.new" "$DIR/.env.new"
  if [ "$NEWDIR" -eq 1 ]; then rm -rf "$DIR"
  elif [ "$source" = git ]; then
    if [ "$GITFRESH" -eq 1 ]; then rm -rf "$DIR/repo"
    elif [ -n "$GITPREV" ]; then gitrun -C "$DIR/repo" reset --hard "$GITPREV" >/dev/null 2>&1; fi
  fi
}
die() { undo; fail "$*"; }

gitrun() { # the token reaches git only through its environment
  (
    export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https
    if [ -n "$AUTH" ]; then
      export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$AUTH" GIT_CONFIG_KEY_1=http.followRedirects GIT_CONFIG_VALUE_1=false
    fi
    exec git "$@"
  )
}
dc() {
  if [ -n "$EF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" --env-file "$EF" "$@"
  else $D compose -p "$name" --project-directory "$PD" -f "$CF" "$@"; fi
}

echo 'PROGRESS 1/5'
EF=''
if [ "$source" = editor ]; then
  printf '%s' "$BOSUN_PARAM_yaml" > "$DIR/compose.yaml.new" || die 'cannot write the compose file'
  case "$BOSUN_PARAM_yaml" in *"$nl") ;; *) echo >> "$DIR/compose.yaml.new" ;; esac
  CF="$DIR/compose.yaml.new"; PD=$DIR
else
  command -v git >/dev/null 2>&1 || die 'git is not installed on this host'
  AUTH=''
  tok=$SECRET_TOKEN; SECRET_TOKEN=
  if [ -n "$tok" ]; then
    case "$tok" in *[!A-Za-z0-9_.~+/=-]*) die 'the Git token has unexpected characters' ;; esac
    if [ "$rhost" = github.com ]; then
      if command -v base64 >/dev/null 2>&1; then b64=$(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')
      elif command -v openssl >/dev/null 2>&1; then b64=$(printf 'x-access-token:%s' "$tok" | openssl base64 -A)
      else die 'neither base64 nor openssl is available to prepare the Git token'; fi
      AUTH="Authorization: Basic $b64"
    else
      echo 'note: the Git token is only used for github.com; this repository is fetched without it'
    fi
  fi
  tok=''
  if [ -d "$DIR/repo/.git" ] && [ "$(gitrun -C "$DIR/repo" config --get remote.origin.url 2>/dev/null)" = "$repo" ]; then
    GITPREV=$(gitrun -C "$DIR/repo" rev-parse HEAD 2>/dev/null)
    gitrun -C "$DIR/repo" fetch --depth 1 origin "$branch" >/dev/null 2>"$errf" || die "git fetch failed: $(lastline)"
    gitrun -C "$DIR/repo" reset --hard FETCH_HEAD >/dev/null 2>"$errf" || die "git checkout failed: $(lastline)"
  else
    rm -rf "$DIR/repo"; GITFRESH=1
    gitrun clone --depth 1 --single-branch --branch "$branch" -- "$repo" "$DIR/repo" >/dev/null 2>"$errf" || die "git clone failed: $(lastline)"
  fi
  CF="$DIR/repo/$file"
  # the compose file must be a regular file inside the checkout (not a link out of it)
  if [ -L "$CF" ] || [ ! -f "$CF" ]; then die "the file $file was not found in the repository"; fi
  real=$(cd "$(dirname "$CF")" 2>/dev/null && pwd -P); root=$(cd "$DIR/repo" && pwd -P)
  case "$real/" in "$root"/*) ;; *) die "the file $file is outside the repository" ;; esac
  PD=$(dirname "$CF")
fi
case "$BOSUN_PARAM_env" in *[![:space:]]*)
  printf '%s' "$BOSUN_PARAM_env" > "$DIR/.env.new" || die 'cannot write the .env file'
  case "$BOSUN_PARAM_env" in *"$nl") ;; *) echo >> "$DIR/.env.new" ;; esac
  EF="$DIR/.env.new" ;;
esac
echo 'PROGRESS 2/5'

cfg=$(dc config --format json 2>"$errf") || die "the compose file is not valid: $(lastline)"

# ---- risky options ----
RISKY=''
add_risk() { case "$RISKY" in *"$1"*) ;; *) RISKY="${RISKY:+$RISKY, }$1" ;; esac; }
sensitive() {
  P=$1 awk 'BEGIN {
    n = split(ENVIRON["P"], a, "/"); k = 0
    for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (k > 0) k--; continue } k++; s[k] = a[i] }
    if (k == 0) exit 0
    p = ""; for (i = 1; i <= k; i++) p = p "/" s[i]
    b = tolower(s[k]); if (b == "docker.sock" || b == "containerd.sock") exit 0
    n = split("/etc /root /proc /sys /boot /usr /var/lib/docker", r, " ")
    for (i = 1; i <= n; i++) if (p == r[i] || index(p, r[i] "/") == 1) exit 0
    if (k >= 3 && s[1] == "home" && s[3] == ".ssh") exit 0
    exit 1 }'
}
host_path_risk() {
  if sensitive "$1"; then add_risk "host path $1"; return 0; fi
  hp1=$(readlink -f -- "$1" 2>/dev/null)
  if [ -n "$hp1" ] && [ "$hp1" != "$1" ] && sensitive "$hp1"; then add_risk "host path $1 (is $hp1)"; fi
  return 0
}
# `docker compose config --format json` prints one key per line, indented by two spaces per level: services at level 2, a service at
# level 4, its settings at level 6, list items and map entries at level 8, the fields of a list item at level 10.
found=$(printf '%s\n' "$cfg" | awk '
  function key(l,   k) { k = l; sub(/^ *"/, "", k); sub(/".*/, "", k); return k }
  function val(l,   s) { s = l; sub(/^[^:]*: */, "", s); sub(/,$/, "", s); return s }
  function unq(s) { if (s ~ /^".*"$/) s = substr(s, 2, length(s) - 2); return s }
  function item(l,   s) { s = l; sub(/^ */, "", s); sub(/,$/, "", s); return unq(s) }
  BEGIN { sec = ""; arr = "" }
  {
    line = $0; match(line, /^ */); ind = RLENGTH
    if (ind == 2 && line ~ /^  "/) { sec = key(line); arr = ""; next }
    if (sec == "volumes" && ind == 8 && key(line) == "device") { v = unq(val(line)); if (v ~ /^\//) print "PATH " v; next }
    if (sec != "services") next
    if (ind == 4) { arr = ""; next }
    if (ind == 6) {
      if (arr != "" && line ~ /^ *(\]|\}),?$/) { arr = ""; next }
      k = key(line); v = val(line); arr = ""
      if (k == "privileged" && v == "true") print "RISK privileged"
      else if (k == "network_mode" && v == "\"host\"") print "RISK host network"
      else if (k == "pid" && v == "\"host\"") print "RISK host PID namespace"
      else if (k == "ipc" && v == "\"host\"") print "RISK host IPC namespace"
      else if (k == "uts" && v == "\"host\"") print "RISK host UTS namespace"
      else if (k == "userns_mode" && v == "\"host\"") print "RISK host user namespace"
      else if (k == "cgroup" && v == "\"host\"") print "RISK host cgroup namespace"
      else if ((k == "cap_add" || k == "devices" || k == "security_opt" || k == "sysctls" || k == "volumes") && line ~ /[\[{]$/) arr = k
      next
    }
    if (arr == "cap_add" && ind == 8) print "RISK capability " item(line)
    else if (arr == "security_opt" && ind == 8) print "RISK security option " item(line)
    else if (arr == "sysctls" && ind == 8) print "RISK sysctl " key(line)
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
    'PATH '*) host_path_risk "${l#PATH }" ;;
  esac
done <<EOF
$found
EOF
if [ -n "$RISKY" ] && [ "$BOSUN_PARAM_allow_risky" != true ]; then
  die "needs the permission to use elevated container options: $RISKY"
fi
echo 'PROGRESS 3/5'

# ---- the checked files become the stack ----
if [ "$source" = editor ]; then
  mv -f "$DIR/compose.yaml.new" "$DIR/compose.yaml" || die 'cannot store the compose file'
  CF="$DIR/compose.yaml"
fi
if [ -f "$DIR/.env.new" ]; then mv -f "$DIR/.env.new" "$DIR/.env" || die 'cannot store the .env file'; EF="$DIR/.env"
else rm -f "$DIR/.env"; EF=''; fi
{
  printf 'source=%s\n' "$source"
  printf 'repo=%s\n' "$repo"
  printf 'branch=%s\n' "$branch"
  printf 'file=%s\n' "$file"
  printf 'updated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$DIR/bosun.meta"
NEWDIR=0; GITFRESH=0; GITPREV=''

if [ "$BOSUN_PARAM_pull" = true ]; then
  dc pull >/dev/null 2>"$errf" || fail "pulling the images failed: $(lastline)"
fi
echo 'PROGRESS 4/5'
dc up -d --remove-orphans >/dev/null 2>"$errf" || fail "docker compose up failed: $(lastline)"
echo 'PROGRESS 5/5'
echo "DONE deployed $name"
exit 0
