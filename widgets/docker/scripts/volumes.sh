#!/bin/sh
# Docker (Linux), dataset: the volumes of the host as one JSON array of {"name","driver","mountpoint","size","containers":N,"created"}.
# size comes from `docker system df -v` (the sizes Docker has measured; empty when unknown), containers counts the containers that mount it.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
sizes=$(mktemp) || exit 1
mounts=$(mktemp) || exit 1
trap 'rm -f "$sizes" "$mounts"' EXIT
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
printf '%s\n' "$rows" | awk -F '\t' -v sizef="$sizes" -v mountf="$mounts" '
  function unq(s) { return (s ~ /^".*"$/) ? substr(s, 2, length(s) - 2) : s }
  function esc(s,   o, i, c, n) { o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
  BEGIN {
    FS = "\t"
    while ((getline l < sizef) > 0) { split(l, p, "\t"); if (p[1] != "") size[p[1]] = p[2] }
    while ((getline l < mountf) > 0) { m = split(l, q, ","); for (i = 1; i <= m; i++) used[q[i]]++ }
    printf "["; first = 1
  }
  NF >= 4 {
    nm = unq($1)
    if (!first) printf ","; first = 0
    printf "{\"name\":%s,\"driver\":%s,\"mountpoint\":%s,\"size\":\"%s\",\"containers\":%d,\"created\":%s}", $1, $2, $3, esc(size[nm]), used[nm] + 0, $4
  }
  END { print "]" }'
