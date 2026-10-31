#!/bin/sh
# Docker (Linux): starts, stops or restarts a container. The container name and the operation arrive as data.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
if ! out=$($D "$BOSUN_PARAM_op" "$BOSUN_PARAM_name" 2>&1); then echo "ERROR: $(printf '%s' "$out" | tail -n 1)"; exit 1; fi
echo "DONE $BOSUN_PARAM_op: $BOSUN_PARAM_name"
