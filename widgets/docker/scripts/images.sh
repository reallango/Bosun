#!/bin/sh
# Docker (Linux), dataset: the images of the host as one JSON array of
# {"id","repo","tag","ref","size","created","containers":N,"dangling":bool}. Untagged images have an empty repo and tag; ref is
# repo:tag, or the id when untagged. created is an ISO 8601 time. Docker's own templates print the strings as JSON.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
used=$(mktemp) || exit 1
trap 'rm -f "$used"' EXIT
# which image (full id) every container uses, one per line
ids=$($D ps -aq --no-trunc 2>/dev/null)
if [ -n "$ids" ]; then
  set -f; set -- $ids; set +f
  $D inspect --type container --format '{{.Image}}' "$@" > "$used" 2>/dev/null
fi
if ! rows=$($D image ls --no-trunc --format '{{json .ID}}{{"\t"}}{{json .Repository}}{{"\t"}}{{json .Tag}}{{"\t"}}{{json .Size}}{{"\t"}}{{.CreatedAt}}' 2>&1); then
  echo "docker image ls failed: $(printf '%s' "$rows" | tail -n 1 | cut -c1-200)" >&2; exit 1
fi
printf '%s\n' "$rows" | awk -F '\t' -v usedf="$used" '
  function unq(s) { return (s ~ /^".*"$/) ? substr(s, 2, length(s) - 2) : s }
  function esc(s,   o, i, c, n) { o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
  function iso(s,   p, o) { n = split(s, p, " "); if (n >= 3 && p[3] ~ /^[+-][0-9][0-9][0-9][0-9]$/) o = p[3]; else return esc(s); return p[1] "T" p[2] substr(o, 1, 3) ":" substr(o, 4, 2) }
  BEGIN { while ((getline l < usedf) > 0) cnt[l]++; printf "[" ; first = 1 }
  NF >= 4 {
    id = unq($1); repo = unq($2); tag = unq($3)
    none = (repo == "<none>"); if (none) repo = ""; if (tag == "<none>") tag = ""
    ref = (repo == "" ) ? id : (tag == "" ? repo : repo ":" tag)
    if (!first) printf ","; first = 0
    sid = id; sub(/^sha256:/, "", sid); sid = substr(sid, 1, 12)
    cr = iso($5); ct = (cr ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) ? substr(cr, 1, 10) " " substr(cr, 12, 5) : cr
    printf "{\"id\":%s,\"short_id\":\"%s\",\"repo\":\"%s\",\"tag\":\"%s\",\"ref\":\"%s\",\"size\":%s,\"created\":\"%s\",\"created_text\":\"%s\",\"containers\":%d,\"dangling\":%s}", $1, esc(sid), esc(repo), esc(tag), esc(ref), $4, cr, esc(ct), cnt[id] + 0, (none && tag == "") ? "true" : "false"
  }
  END { print "]" }'
