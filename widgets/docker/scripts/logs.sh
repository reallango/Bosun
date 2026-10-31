#!/bin/sh
# Docker (Linux): the recent log output of a container. The container name and the number of lines arrive as data.
# A container writes whatever it likes to its log, including lines that look like this job protocol (`ERROR: ...`, `DONE ...`,
# `PROGRESS n/m`, `[step] ...`). Every such line gets one space in front, so the job shows the log and never mistakes it for
# its own status.
name=$BOSUN_PARAM_name; lines=$BOSUN_PARAM_lines
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) echo 'ERROR: invalid container name'; exit 1 ;; esac
[ "${#name}" -le 128 ] || { echo 'ERROR: invalid container name'; exit 1; }
case "$lines" in ''|*[!0-9]*) echo 'ERROR: invalid number of lines'; exit 1 ;; esac
tmp=$(mktemp) || { echo 'ERROR: cannot create a temporary file'; exit 1; }
trap 'rm -f "$tmp"' EXIT
$D logs --tail "$lines" "$name" > "$tmp" 2>&1; rc=$?
awk '{ if ($0 ~ /^(ERROR:|DONE|PROGRESS|\[[Ss][Tt][Ee][Pp]\])/) print " " $0; else print $0 }' "$tmp"
exit $rc
