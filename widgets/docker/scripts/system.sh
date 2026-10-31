#!/bin/sh
# Docker (Linux), dataset: one JSON object {"version","containers":{"total","running","paused","stopped"},"images":N,
# "disk":{"images","containers","volumes","cache"},"compose":bool}. disk values are the sizes `docker system df` prints (for example
# "1.2GB", empty when unknown); compose says whether the `docker compose` plugin works.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
version=$($D version --format '{{json .Server.Version}}' 2>/dev/null | tail -n 1)
case "$version" in \"*\") ;; *) version='""' ;; esac
set -- 0 0 0 0 0
info=$($D info --format '{{.Containers}} {{.ContainersRunning}} {{.ContainersPaused}} {{.ContainersStopped}} {{.Images}}' 2>/dev/null | tail -n 1)
case "$info" in *[![:digit:][:space:]]*|'') ;; *) set -f; set -- $info; set +f ;; esac
[ "$#" -eq 5 ] || set -- 0 0 0 0 0
disk=$($D system df --format '{{.Type}}|{{.Size}}' 2>/dev/null)
size_of() { printf '%s\n' "$disk" | awk -F '|' -v t="$1" '$1 == t { print $2; exit }' | tr -d '\r'; }
esc() { printf '%s' "$1" | tr -d '[:cntrl:]' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
if $D compose version >/dev/null 2>&1; then compose=true; else compose=false; fi
printf '{"version":%s,"containers":{"total":%s,"running":%s,"paused":%s,"stopped":%s},"images":%s,' "$version" "$1" "$2" "$3" "$4" "$5"
printf '"disk":{"images":"%s","containers":"%s","volumes":"%s","cache":"%s"},"compose":%s}\n' \
  "$(esc "$(size_of Images)")" "$(esc "$(size_of Containers)")" "$(esc "$(size_of 'Local Volumes')")" "$(esc "$(size_of 'Build Cache')")" "$compose"
