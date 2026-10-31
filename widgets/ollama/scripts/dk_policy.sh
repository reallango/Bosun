#!/bin/sh
# Ollama (Linux, container): changes the restart policy of the container. Both values arrive as data.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
if ! $D update --restart="$BOSUN_PARAM_policy" "$BOSUN_PARAM_container" >/dev/null 2>&1; then echo 'ERROR: Could not change the restart policy'; exit 1; fi
echo "DONE Restart policy: $BOSUN_PARAM_policy"
