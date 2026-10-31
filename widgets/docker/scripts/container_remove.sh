#!/bin/sh
# Docker (Linux): removes a container (running ones are stopped by force). With volumes=true its anonymous volumes go too.
# Parameters: name, volumes (true/false).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid container name' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid container name'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
set -- rm -f
[ "$BOSUN_PARAM_volumes" = true ] && set -- "$@" -v
set -- "$@" "$name"
echo 'PROGRESS 0/1'
if ! out=$($D "$@" 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/1'
echo "DONE removed $name"
exit 0
