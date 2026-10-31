#!/bin/sh
# Docker (Linux): removes an image (by name[:tag] or id). With force=true it is removed even when containers use it or it has several tags.
# Parameters: ref, force (true/false).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
ref=$BOSUN_PARAM_ref
case "$ref" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9._/:@-]*) fail 'invalid image reference' ;; esac
[ "${#ref}" -le 255 ] || fail 'invalid image reference'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
set -- rmi
[ "$BOSUN_PARAM_force" = true ] && set -- "$@" -f
set -- "$@" "$ref"
echo 'PROGRESS 0/1'
if ! out=$($D "$@" 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/1'
echo "DONE removed $ref"
exit 0
