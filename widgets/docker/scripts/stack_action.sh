#!/bin/sh
# Docker (Linux): runs one operation on a compose stack: up, down, restart, pull, stop or start (`docker compose -p <name> ...`
# with the stack's stored files from $HOME/bosun-stacks/<name>/). A stack Bosun did not create (external) can only be
# stopped, started, restarted or taken down (docker compose finds its containers by label); up and pull need the stored files.
# Parameters: name, op.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name; op=$BOSUN_PARAM_op
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'invalid stack name' ;; esac
[ "${#name}" -le 63 ] || fail 'invalid stack name'
case "$op" in
  up) set -- up -d --remove-orphans ;;
  down) set -- down ;;
  restart) set -- restart ;;
  pull) set -- pull ;;
  stop) set -- stop ;;
  start) set -- start ;;
  *) fail 'op must be up, down, restart, pull, stop or start' ;;
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
  case "$op" in up|pull) fail "the stack $name was not created by Bosun (no stored compose file), so $op is not possible" ;; esac
fi
errf=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$errf"' EXIT
echo 'PROGRESS 0/1'; echo "[step] Running docker compose $op for the stack $name"
if [ -z "$CF" ]; then $D compose -p "$name" "$@" >/dev/null 2>"$errf"; rc=$?
elif [ -n "$EF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" --env-file "$EF" "$@" >/dev/null 2>"$errf"; rc=$?
else $D compose -p "$name" --project-directory "$PD" -f "$CF" "$@" >/dev/null 2>"$errf"; rc=$?; fi
if [ "$rc" -ne 0 ]; then fail "docker compose $op failed: $(tr -d '\r' < "$errf" | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400)"; fi
echo 'PROGRESS 1/1'
echo "DONE $op: $name"
exit 0
