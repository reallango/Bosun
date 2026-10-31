#!/bin/sh
# Docker (Linux): the containers of the host, one JSON object per line (what `docker ps -a` knows). The account Bosun connects
# with is in the docker group or can use sudo for docker; if neither works the widget says that Docker is not available.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
$D ps -a --no-trunc --format '{{json .}}'
