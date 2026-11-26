#!/bin/sh
# Docker (Linux): the containers of the host, one JSON object per line. The account Bosun connects
# with is in the docker group or can use sudo for docker; if neither works the widget says that Docker is not available.
# Only the fields the list shows are printed. Everyone with "See containers" gets this data (API keys too), so
# never add the start command, the labels, mounts or anything else that can carry secrets: those stay behind
# "Create and change containers" (the inspect script).
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
$D ps -a --no-trunc --format '{"ID":{{json .ID}},"Names":{{json .Names}},"Image":{{json .Image}},"State":{{json .State}},"Status":{{json .Status}},"Ports":{{json .Ports}},"CreatedAt":{{json .CreatedAt}},"RunningFor":{{json .RunningFor}},"ComposeProject":{{json (.Label "com.docker.compose.project")}},"ComposeService":{{json (.Label "com.docker.compose.service")}}}'
