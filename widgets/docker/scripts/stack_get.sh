#!/bin/sh
# Docker (Linux), dataset: the stored files of a stack as one JSON object, every field a string:
#   {"name","source" ("editor"|"git"|"external"),"repo","branch","file","yaml","env","override"}
# "override" is the text of the override lines stack_deploy stored (svc.<service>.<key>=value, bosun.override), "" when there are none.
# A Bosun-managed stack lives in $HOME/bosun-stacks/<name>/ (compose.yaml, .env, bosun.override, compose.override.yaml, bosun.meta,
# and repo/ for the git source).
# A stack Bosun did not create (external) is only known to docker compose: its yaml is read from the project's first config file
# when that file is readable, else it is empty. Parameter: name.
fail() { echo "$*" >&2; exit 1; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail 'invalid stack name' ;; esac
[ "${#name}" -le 63 ] || fail 'invalid stack name'
case "$HOME" in /*) ;; *) fail 'HOME is not set' ;; esac
DIR="$HOME/bosun-stacks/$name"
# JSON-string helpers: control characters are dropped, \ and " escaped, newlines kept as \n (the text always ends with one).
jstr() { V=$1 awk 'BEGIN { s = ENVIRON["V"]; o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } printf "\"%s\"", o }'; }
jfile() { # $1 = file, at most 1 MB of text
  if [ -f "$1" ] && [ -r "$1" ]; then
    head -c 1048576 "$1" | awk 'function esc(s,   o, i, c, n) { o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c == "\t") o = o "\\t"; else if (c == "\r") o = o "\\r"; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
      BEGIN { printf "\"" } { printf "%s", esc($0) "\\n" } END { printf "\"" }'
  else printf '""'; fi
}
meta_get() { [ -f "$DIR/bosun.meta" ] || return 0; while IFS= read -r l; do case "$l" in "$1="*) printf '%s' "${l#*=}"; return 0 ;; esac; done < "$DIR/bosun.meta"; }

if [ -d "$DIR" ]; then
  source=$(meta_get source); case "$source" in git) ;; *) source=editor ;; esac
  repo=$(meta_get repo); branch=$(meta_get branch); file=$(meta_get file)
  if [ "$source" = git ]; then
    case "$file" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) yamlf='' ;; *) yamlf="$DIR/repo/$file" ;; esac
    # a link inside the repository must not lead the reader somewhere else
    if [ -n "$yamlf" ] && { [ -L "$yamlf" ] || [ ! -f "$yamlf" ]; }; then yamlf=''; fi
  else yamlf="$DIR/compose.yaml"; fi
  printf '{"name":%s,"source":%s,"repo":%s,"branch":%s,"file":%s,"yaml":%s,"env":%s,"override":%s}\n' \
    "$(jstr "$name")" "$(jstr "$source")" "$(jstr "$repo")" "$(jstr "$branch")" "$(jstr "$file")" "$(jfile "$yamlf")" "$(jfile "$DIR/.env")" "$(jfile "$DIR/bosun.override")"
  exit 0
fi

# external: only docker compose knows it
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
cfg=$($D compose ls -a --format json 2>/dev/null | sed 's/},{/}\n{/g' | grep "\"Name\":\"$name\"" | head -n 1 | sed -n 's/.*"ConfigFiles":"\([^"]*\)".*/\1/p')
found=$($D ps -a --filter "label=com.docker.compose.project=$name" -q 2>/dev/null | head -n 1)
[ -n "$cfg" ] || [ -n "$found" ] || fail "stack $name not found"
first=${cfg%%,*}
case "$first" in /*) ;; *) first='' ;; esac
printf '{"name":%s,"source":"external","repo":"","branch":"","file":"","yaml":%s,"env":"","override":""}\n' "$(jstr "$name")" "$(jfile "$first")"
