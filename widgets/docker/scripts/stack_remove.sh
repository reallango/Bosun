#!/bin/sh
# Docker (Linux): takes a compose stack down (`docker compose down --remove-orphans`, with --volumes when asked) and deletes
# its folder $HOME/bosun-stacks/<name>/ (the stored compose file, .env and git checkout). A stack Bosun did not create is only
# taken down. Parameters: name, volumes (true/false).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'invalid stack name' ;; esac
[ "${#name}" -le 63 ] || fail 'invalid stack name'
case "$HOME" in /?*) ;; *) fail 'HOME is not set' ;; esac
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
$D compose version >/dev/null 2>&1 || fail 'Docker Compose (the docker compose plugin) is not installed on this host'
DIR="$HOME/bosun-stacks/$name"
meta_get() { [ -f "$DIR/bosun.meta" ] || return 0; while IFS= read -r l; do case "$l" in "$1="*) printf '%s' "${l#*=}"; return 0 ;; esac; done < "$DIR/bosun.meta"; }
set -- down --remove-orphans
[ "$BOSUN_PARAM_volumes" = true ] && set -- "$@" --volumes
CF=''; PD=''; EF=''
if [ -d "$DIR" ]; then
  if [ "$(meta_get source)" = git ]; then
    f=$(meta_get file)
    case "$f" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) f='' ;; esac
    [ -z "$f" ] || CF="$DIR/repo/$f"
  else CF="$DIR/compose.yaml"; fi
  [ -f "$CF" ] || CF=''
  [ -z "$CF" ] || { PD=$(dirname "$CF"); [ ! -f "$DIR/.env" ] || EF="$DIR/.env"; }
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
echo 'PROGRESS 0/2'; echo "[step] Taking the stack $name down"
if [ -z "$CF" ]; then $D compose -p "$name" "$@" >/dev/null 2>"$errf"; rc=$?
elif [ -n "$EF" ]; then $D compose -p "$name" --project-directory "$PD" -f "$CF" --env-file "$EF" "$@" >/dev/null 2>"$errf"; rc=$?
else $D compose -p "$name" --project-directory "$PD" -f "$CF" "$@" >/dev/null 2>"$errf"; rc=$?; fi
if [ "$rc" -ne 0 ]; then fail "docker compose down failed: $(tr -d '\r' < "$errf" | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400)"; fi
echo 'PROGRESS 1/2'
echo '[step] Deleting the stored stack files'
[ ! -d "$DIR" ] || rm -rf "$DIR"
echo 'PROGRESS 2/2'
echo "DONE removed stack $name"
exit 0
