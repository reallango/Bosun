#!/bin/sh
# Docker (Linux), dataset: one JSON object {"version","containers":{"total","running","paused","stopped"},"images":N,
# "disk":{"images","containers","volumes","cache"},"compose":bool,"drivers":{"volume":[...],"network":[...]}}. disk values are the
# sizes `docker system df` prints (for example "1.2GB", empty when unknown); compose says whether the `docker compose` plugin
# works; drivers are the volume and network drivers the daemon has (`docker info`: local, bridge, overlay, macvlan, ...).
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
esc() { printf '%s' "$1" | tr -d '[:cntrl:]' | sed -e 's/\/\\/g' -e 's/"/\\"/g'; }
if $D compose version >/dev/null 2>&1; then compose=true; else compose=false; fi
# drivers: one tagged line per driver (V volume, N network); anything else the daemon prints is ignored
dfmt='{{range .Plugins.Volume}}V {{.}}
{{end}}{{range .Plugins.Network}}N {{.}}
{{end}}'
drivers=$($D info --format "$dfmt" 2>/dev/null | tr -d '\r')
list_drivers() { # $1 = V or N; a JSON array of the valid names, or the fallback in $2
  printf '%s\n' "$drivers" | awk -v t="$1" -v fb="$2" '
    $1 == t && $2 ~ /^[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/ && length($2) <= 100 && !($2 in seen) { seen[$2] = 1; o = o (n++ ? "," : "") "\"" $2 "\"" }
    END { if (n == 0) o = fb; printf "[%s]", o }'
}
printf '{"version":%s,"containers":{"total":%s,"running":%s,"paused":%s,"stopped":%s},"images":%s,' "$version" "$1" "$2" "$3" "$4" "$5"
printf '"disk":{"images":"%s","containers":"%s","volumes":"%s","cache":"%s"},"compose":%s,' \
  "$(esc "$(size_of Images)")" "$(esc "$(size_of Containers)")" "$(esc "$(size_of 'Local Volumes')")" "$(esc "$(size_of 'Build Cache')")" "$compose"
printf '"drivers":{"volume":%s,"network":%s}}\n' "$(list_drivers V '"local"')" "$(list_drivers N '"bridge","host","none"')"
