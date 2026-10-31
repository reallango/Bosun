#!/bin/sh
# Docker (Linux): removes unused volumes (what `docker volume prune -f` removes: anonymous unused volumes on current Docker;
# named volumes are never pruned by this script).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
echo 'PROGRESS 0/1'
if ! out=$($D volume prune -f 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/1'
rec=$(printf '%s\n' "$out" | tr -d '\r' | grep -i 'reclaimed' | tail -n 1 | cut -c1-200)
echo "DONE pruned volumes${rec:+ ($rec)}"
exit 0
