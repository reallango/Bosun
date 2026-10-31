#!/bin/sh
# Docker (Linux): creates a named volume.
# Parameters: name, driver (optional; empty means the default driver, local).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name; driver=$BOSUN_PARAM_driver
[ "$driver" != - ] || driver=
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid volume name (letters, digits, _ . - only)' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid volume name'
case "$driver" in ''|[a-zA-Z0-9]*) ;; *) fail 'invalid volume driver' ;; esac
case "$driver" in *[!a-zA-Z0-9_.:/-]*) fail 'invalid volume driver' ;; esac
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
set -- volume create
[ -z "$driver" ] || set -- "$@" --driver "$driver"
set -- "$@" "$name"
echo 'PROGRESS 0/1'
if ! out=$($D "$@" 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/1'
echo "DONE created volume $name"
exit 0
