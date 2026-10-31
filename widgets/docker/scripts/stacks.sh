#!/bin/sh
# Docker (Linux), dataset: the compose stacks of the host as one JSON array of
#   {"name","status" (running|partial|stopped),"services":N,"source":"editor"|"git"|"external","repo","branch","file","updated"}
# The projects docker knows come from the compose labels of the containers (every container, running or not); Bosun's own
# records ($HOME/bosun-stacks/<name>/bosun.meta) add the source, the repository and the time of the last deployment, and list
# stacks that were deployed but have no containers (status stopped). Everything not recorded by Bosun is "external".
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
in=$(mktemp) || exit 1
trap 'rm -f "$in"' EXIT
tab=$(printf '\t')
$D ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}{{"\t"}}{{.Label "com.docker.compose.service"}}{{"\t"}}{{.State}}' 2>/dev/null | sed "s/^/C$tab/" > "$in"
case "$HOME" in /*)
  for d in "$HOME"/bosun-stacks/*/; do
    [ -d "$d" ] || continue
    n=${d%/}; n=${n##*/}
    case "$n" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) continue ;; esac
    src=''; repo=''; branch=''; file=''; upd=''
    if [ -f "$d/bosun.meta" ]; then
      while IFS= read -r l; do
        case "$l" in
          source=*) src=${l#*=} ;; repo=*) repo=${l#*=} ;; branch=*) branch=${l#*=} ;; file=*) file=${l#*=} ;; updated=*) upd=${l#*=} ;;
        esac
      done < "$d/bosun.meta"
    fi
    case "$src" in git) ;; *) src=editor ;; esac
    # no tabs inside a value
    printf 'M\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$src" "$(printf '%s' "$repo" | tr -d "$tab")" "$(printf '%s' "$branch" | tr -d "$tab")" "$(printf '%s' "$file" | tr -d "$tab")" "$(printf '%s' "$upd" | tr -d "$tab")" >> "$in"
  done ;;
esac
awk -F '\t' '
  function esc(s,   o, i, c, n) { o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
  $1 == "C" && $2 != "" {
    names[$2] = 1
    if (!(($2 SUBSEP $3) in seen)) { seen[$2 SUBSEP $3] = 1; svc[$2]++ }
    if ($4 == "running") run[$2]++; else other[$2]++
  }
  $1 == "M" { names[$2] = 1; src[$2] = $3; repo[$2] = $4; branch[$2] = $5; file[$2] = $6; upd[$2] = $7 }
  END {
    for (n in names) {
      st = (run[n] > 0) ? ((other[n] > 0) ? "partial" : "running") : "stopped"
      s = (n in src) ? src[n] : "external"
      printf "%s\t{\"name\":\"%s\",\"status\":\"%s\",\"services\":%d,\"source\":\"%s\",\"repo\":\"%s\",\"branch\":\"%s\",\"file\":\"%s\",\"updated\":\"%s\"}\n", n, esc(n), st, svc[n] + 0, s, esc(repo[n]), esc(branch[n]), esc(file[n]), esc(upd[n])
    }
  }' "$in" | sort | cut -f2- | awk 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "%s", $0 } END { print "]" }'
