#!/bin/sh
# Docker (Linux): starts, stops or restarts a container. The container name and the operation arrive as data.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
case "$BOSUN_PARAM_op" in start|stop|restart) ;; *) echo 'ERROR: the operation must be start, stop or restart'; exit 1 ;; esac
case "$BOSUN_PARAM_name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) echo 'ERROR: invalid container name'; exit 1 ;; esac
if ! out=$($D "$BOSUN_PARAM_op" "$BOSUN_PARAM_name" 2>&1); then echo "ERROR: $(printf '%s\n' "$out" | tail -n 1 | tr -d '[:cntrl:]' | cut -c1-300)"; exit 1; fi
echo "DONE $BOSUN_PARAM_op: $BOSUN_PARAM_name"
