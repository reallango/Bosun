#!/bin/sh
# Docker (Linux): the recent log output of a container. The container name and the number of lines arrive as data.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
$D logs --tail "$BOSUN_PARAM_lines" "$BOSUN_PARAM_name" 2>&1
