#!/bin/sh
# Docker (Linux), dataset: the volumes of the host as one JSON array of
# {"name","driver","mountpoint","size","containers":N,"created","created_iso"}. created is the creation time in the host's
# local time as the images dataset shows it (YYYY-MM-DD HH:MM); created_iso keeps the time Docker reported (sorting).
# size comes from `docker system df -v` (the sizes Docker has measured; empty when unknown), containers counts the containers that mount it.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
sizes=$(mktemp) || exit 1
mounts=$(mktemp) || exit 1
times=$(mktemp) || exit 1
trap 'rm -f "$sizes" "$mounts" "$times"' EXIT
names=$($D volume ls -q 2>/dev/null)
if [ -z "$names" ]; then echo '[]'; exit 0; fi
# (a real newline inside the template: Docker rewrites the two characters \n before it parses the template)
$D system df -v --format '{{range .Volumes}}{{.Name}}{{"\t"}}{{.Size}}
{{end}}' > "$sizes" 2>/dev/null
$D ps -a --no-trunc --format '{{.Mounts}}' > "$mounts" 2>/dev/null
set -f; set -- $names; set +f
if ! rows=$($D volume inspect --format '{{json .Name}}{{"\t"}}{{json .Driver}}{{"\t"}}{{json .Mountpoint}}{{"\t"}}{{json .CreatedAt}}' "$@" 2>&1); then
  echo "docker volume inspect failed: $(printf '%s' "$rows" | tail -n 1 | cut -c1-200)" >&2; exit 1
fi
# CreatedAt comes as UTC (2026-10-27T21:45:58Z); show it in the host's local time like the images dataset does. A host whose
# date cannot read it keeps the UTC value cut to YYYY-MM-DD HH:MM (the awk below).
printf '%s\n' "$rows" | cut -f 4 | tr -d '"' | sed '/^$/d' | sort -u | while IFS= read -r iso; do
  loc=$(date -d "$iso" '+%Y-%m-%d %H:%M' 2>/dev/null) || loc=''
  case "$loc" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]) ;; *) loc='' ;; esac
  printf '%s\t%s\n' "$iso" "$loc"
done > "$times"
printf '%s\n' "$rows" | awk -F '\t' -v sizef="$sizes" -v mountf="$mounts" -v timef="$times" '
  function unq(s) { return (s ~ /^".*"$/) ? substr(s, 2, length(s) - 2) : s }
  function esc(s,   o, i, c, n) { o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
  BEGIN {
    FS = "\t"
    while ((getline l < sizef) > 0) { split(l, p, "\t"); if (p[1] != "") size[p[1]] = p[2] }
    while ((getline l < mountf) > 0) { m = split(l, q, ","); for (i = 1; i <= m; i++) used[q[i]]++ }
    while ((getline l < timef) > 0) { i = index(l, "\t"); if (i > 1) shown[substr(l, 1, i - 1)] = substr(l, i + 1) }
    printf "["; first = 1
  }
  NF >= 4 {
    nm = unq($1); iso = unq($4)
    ct = shown[iso]; if (ct == "") ct = (iso ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]/) ? substr(iso, 1, 10) " " substr(iso, 12, 5) : iso
    if (!first) printf ","; first = 0
    printf "{\"name\":%s,\"driver\":%s,\"mountpoint\":%s,\"size\":\"%s\",\"containers\":%d,\"created\":\"%s\",\"created_iso\":\"%s\"}", $1, $2, $3, esc(size[nm]), used[nm] + 0, esc(ct), esc(iso)
  }
  END { print "]" }'
