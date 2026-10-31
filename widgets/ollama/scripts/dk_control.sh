#!/bin/sh
# Ollama (Linux, container): starts, stops or restarts the container. The container name and the operation arrive as data.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
if ! $D "$BOSUN_PARAM_op" "$BOSUN_PARAM_container" >/dev/null 2>&1; then echo "ERROR: Could not $BOSUN_PARAM_op the container"; exit 1; fi
echo "DONE $BOSUN_PARAM_op: $($D inspect -f '{{.State.Status}}' "$BOSUN_PARAM_container" 2>/dev/null)"
