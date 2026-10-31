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
trap 'rm -f "$errf"' EXIT
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
