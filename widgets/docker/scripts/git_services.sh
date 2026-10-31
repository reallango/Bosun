#!/bin/sh
# Docker (Linux), dataset: the services of a compose file in a Git repository, for the stack dialog (ports, volumes and networks a
# person can then override):
#   {"services":[{"name":"web","container_name":"","image":"nginx","ports":["8080:80/tcp"],"volumes":["./data:/data"],"networks":["default"]}],
#    "networks":["default","backend"],"warnings":["..."]}
# A shallow single-branch clone (depth 1) goes into a temporary folder that is removed afterwards (hooks off, nothing of it runs), then
# `docker compose config --format json` reads the file. The services come in the order of the file; "default" is the first network.
# Variables the file needs but nobody set must not stop this: unset ones count as blank and are reported in "warnings"; a required one
# (${VAR:?message}) makes it read the file again without expanding variables (they then show as written), with a warning. compose
# runs with a clean environment (only PATH, HOME and the Docker client settings), so nothing of this host leaks into the answer.
# Same https/host/token rules as stack_deploy. A failure prints `ERROR: message` (exit 0). Parameters: repo, branch, file.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
branch=$BOSUN_PARAM_branch; file=$BOSUN_PARAM_file
case "$branch" in ''|-*|*..*|*[!A-Za-z0-9._/-]*) fail 'branch: use letters, digits and . _ / - only' ;; esac
[ "${#branch}" -le 100 ] || fail 'branch: too long'
case "$file" in ''|-*|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'file: a relative path inside the repository (letters, digits and . _ / - only)' ;; esac
[ "${#file}" -le 200 ] || fail 'file: too long'
# >>> git helpers (the same text in git_branches.sh, git_files.sh and git_services.sh; a test compares them)
# Git over https only. BOSUN_SECRET_git_token (exported by Bosun, when the package secret is set) is sent as a Basic Authorization header
# through the environment of the git process only (GIT_CONFIG_*), never on a command line, in a URL, in a file or in the output, and
# only to github.com. Nothing of the repository is ever run: hooks are off, file:// and other protocols are refused, LFS is not smudged.
SECRET_TOKEN=$BOSUN_SECRET_git_token; unset BOSUN_SECRET_git_token   # never let git, docker or compose inherit it by accident
repo=$BOSUN_PARAM_repo
case "$repo" in https://*) ;; *) fail 'repo: use an https:// address' ;; esac
rr=${repo#https://}
case "$rr" in */*) ;; *) fail 'repo: use https://host/owner/name' ;; esac
rhost=${rr%%/*}; rpath=${rr#*/}
case "$rhost" in ''|-*|.*|*[!A-Za-z0-9.-]*|*..*) fail 'repo: invalid host' ;; esac
case "$rpath" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'repo: invalid path' ;; esac
[ "${#repo}" -le 300 ] || fail 'repo: too long'
command -v git >/dev/null 2>&1 || fail 'git is not installed on this host'
AUTH=''
if [ -n "$SECRET_TOKEN" ]; then
  case "$SECRET_TOKEN" in *[!A-Za-z0-9_.~+/=-]*) fail 'the Git token has unexpected characters' ;; esac
  if [ "$rhost" = github.com ]; then
    if command -v base64 >/dev/null 2>&1; then b64=$(printf 'x-access-token:%s' "$SECRET_TOKEN" | base64 | tr -d '\n')
    elif command -v openssl >/dev/null 2>&1; then b64=$(printf 'x-access-token:%s' "$SECRET_TOKEN" | openssl base64 -A)
    else fail 'neither base64 nor openssl is available to prepare the Git token'; fi
    AUTH="Authorization: Basic $b64"
  fi
fi
SECRET_TOKEN=''
gitrun() { # the token reaches git only through its environment
  (
    export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https GIT_LFS_SKIP_SMUDGE=1 GIT_ASKPASS=/bin/true
    if [ -n "$AUTH" ]; then
      export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$AUTH" GIT_CONFIG_KEY_1=http.followRedirects GIT_CONFIG_VALUE_1=false
    fi
    exec git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=never "$@" < /dev/null
  )
}
lasterr() { tr -d '\r' < "$1" | sed '/^$/d' | tail -n 2 | tr '\n' ' ' | cut -c1-300; }
# <<< git helpers

D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || fail 'Docker is not available to this account'
$D compose version >/dev/null 2>&1 || fail 'Docker Compose (the docker compose plugin) is not installed on this host'
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
if ! gitrun clone --quiet --depth 1 --single-branch --branch "$branch" -- "$repo" "$tmp/repo" > /dev/null 2> "$tmp/err"; then
  fail "git clone failed: $(lasterr "$tmp/err")"
fi
CF="$tmp/repo/$file"
# the compose file must be a regular file inside the checkout (not a link out of it)
if [ -L "$CF" ] || [ ! -f "$CF" ]; then fail "the file $file was not found in the repository"; fi
real=$(cd "$(dirname "$CF")" 2>/dev/null && pwd -P); root=$(cd "$tmp/repo" && pwd -P)
case "$real/" in "$root"/*) ;; *) fail "the file $file is outside the repository" ;; esac
PD=$real

# docker compose with a clean environment: only what the Docker client needs
cenv() {
  env -i PATH="$PATH" HOME="$HOME" DOCKER_HOST="${DOCKER_HOST-}" DOCKER_CONFIG="${DOCKER_CONFIG-}" DOCKER_CONTEXT="${DOCKER_CONTEXT-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" "$@"
}
: > "$tmp/warn"
cfg() { # $1 = extra option of docker compose config (or nothing)
  cenv $D compose --project-directory "$PD" -f "$CF" config $1 --format json > "$tmp/cfg" 2> "$tmp/cerr" < /dev/null
}
if ! cfg ''; then
  if grep -Eqi 'required variable|is required|must be set' "$tmp/cerr"; then
    rv=$(tr -d '\r' < "$tmp/cerr" | sed -n 's/.*\(required variable [A-Za-z0-9_]* is missing a value[^"]*\).*/\1/p' | head -n 1 | cut -c1-200)
    [ -n "$rv" ] || rv=$(lasterr "$tmp/cerr")
    printf '%s\n' "The file needs a variable that is not set ($rv): it is shown with the variables as written" > "$tmp/warn"
    cfg --no-interpolate || fail "docker compose could not read the file: $(lasterr "$tmp/cerr")"
  else
    fail "docker compose could not read the file: $(lasterr "$tmp/cerr")"
  fi
else
  # unset variables compose replaced by blanks
  tr -d '\r' < "$tmp/cerr" | sed -n 's/.*The .\{0,2\}\([A-Za-z_][A-Za-z0-9_]*\).\{0,2\} variable is not set.*/The variable \1 is not set (counted as blank)/p' | sort -u | head -n 20 > "$tmp/warn"
fi

cat > "$tmp/prog.awk" <<'BOSUN_AWK_END'
# >>> json flatten (the same text in convert.sh and git_services.sh; a test compares them): the JSON of docker compose config as paths
function jws(   c) { while (JP <= JL) { c = substr(JS, JP, 1); if (c == " " || c == "\n" || c == "\t" || c == "\r") JP++; else break } }
function hexv(h,   i, n, c) { n = 0; h = tolower(h); for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)); if (c == 0) return 63; n = n * 16 + c - 1 } return n }
function jstring(   c, o, n) {
  JP++; o = ""
  while (JP <= JL) {
    c = substr(JS, JP, 1)
    if (c == "\"") { JP++; return o }
    if (c == "\\") {
      JP++; c = substr(JS, JP, 1)
      if (c == "n") o = o "\n"; else if (c == "t") o = o "\t"; else if (c == "r") o = o "\r"; else if (c == "b") o = o "\b"; else if (c == "f") o = o "\f"
      else if (c == "u") { n = hexv(substr(JS, JP + 1, 4)); JP += 4; if (n > 0 && n < 128) o = o sprintf("%c", n); else if (n >= 128) o = o "?" }
      else o = o c
    } else o = o c
    JP++
  }
  return o
}
function jval(path,   c, k, n, t) {
  jws(); c = substr(JS, JP, 1)
  if (c == "{") {
    JT[path] = "o"; JP++; jws(); n = 0
    if (substr(JS, JP, 1) == "}") { JP++; JN[path] = 0; return }
    while (JP <= JL) {
      jws(); k = jstring(); jws(); JP++; n++; JK[path, n] = k
      jval(path SUBSEP k)
      jws(); c = substr(JS, JP, 1); JP++
      if (c == "}") break
    }
    JN[path] = n; return
  }
  if (c == "[") {
    JT[path] = "a"; JP++; jws(); n = 0
    if (substr(JS, JP, 1) == "]") { JP++; JN[path] = 0; return }
    while (JP <= JL) {
      n++; jval(path SUBSEP n)
      jws(); c = substr(JS, JP, 1); JP++
      if (c == "]") break
    }
    JN[path] = n; return
  }
  if (c == "\"") { JT[path] = "s"; JV[path] = jstring(); t0 = JV[path]; gsub(/\$\$/, "", t0); if (t0 ~ /\$[A-Za-z_{]/) VARSEEN = 1; gsub(/\$\$/, "$", JV[path]); return }
  k = JP
  while (JP <= JL) { c = substr(JS, JP, 1); if (c == "," || c == "}" || c == "]" || c == " " || c == "\n" || c == "\r" || c == "\t") break; JP++ }
  t = substr(JS, k, JP - k)
  if (t == "null") { JT[path] = "z"; JV[path] = ""; return }
  JT[path] = (t == "true" || t == "false") ? "b" : "n"; JV[path] = t
}
function ch(p, k) { return p SUBSEP k }
function has(p) { return (p in JT) && JT[p] != "z" }
function cstr(p) { return ((p in JT) && (JT[p] == "s" || JT[p] == "n" || JT[p] == "b")) ? JV[p] : "" }
function ctrue(p) { return (p in JT) && (JV[p] == "true" || JV[p] == "yes" || JV[p] == "1") && (JT[p] == "b" || JT[p] == "s" || JT[p] == "n") }
function isempty(p) { if (!(p in JT) || JT[p] == "z") return 1; if (JT[p] == "a" || JT[p] == "o") return JN[p] == 0; if (JT[p] == "b") return JV[p] == "false"; return JV[p] == "" }
# <<< json flatten
function jesc(s,   o, i, c, n) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c in CC) o = o CC[c]; else o = o c }
  return o
}
BEGIN { for (i = 1; i < 32; i++) CC[sprintf("%c", i)] = sprintf("\\u%04x", i); CC["\t"] = "\\t"; CC["\r"] = "\\r"; CC["\n"] = "\\n" }
function jq(s) { return "\"" jesc(s) "\"" }
function rel(src) { if (index(src, PROJ "/") == 1) return "./" substr(src, length(PROJ) + 2); return src }
{ TEXT = TEXT $0 "\n" }
END {
  JS = ""
  while ((getline line < CFGFILE) > 0) JS = JS line "\n"
  close(CFGFILE)
  JL = length(JS); JP = 1; R = "R"
  jval(R)
  sv = ch(R, "services")
  # the services in the order of the file (compose prints them sorted)
  n = split(TEXT, LINES, "\n"); ins = 0; sind = -1; no = 0
  for (i = 1; i <= n; i++) {
    line = LINES[i]
    if (!ins) { if (line ~ /^services[ \t]*:/) ins = 1; continue }
    if (line ~ /^[ \t]*(#.*)?$/) continue
    if (line ~ /^[^ \t]/) break
    match(line, /^[ \t]*/)
    if (sind < 0) sind = RLENGTH
    if (RLENGTH == sind && line ~ /^[ \t]*[^ \t#-][^:]*:/) { k = line; sub(/^[ \t]*/, "", k); sub(/[ \t]*:.*/, "", k); gsub(/^["']|["']$/, "", k); if (has(ch(sv, k)) && !(k in done)) { done[k] = 1; ord[++no] = k } }
  }
  for (i = 1; i <= JN[sv]; i++) { k = JK[sv, i]; if (!(k in done)) { done[k] = 1; ord[++no] = k } }
  out = ""
  for (s = 1; s <= no; s++) {
    nm = ord[s]; sp = ch(sv, nm)
    ports = ""; vols = ""; nets = ""
    pp = ch(sp, "ports")
    for (i = 1; i <= JN[pp]; i++) {
      e = ch(pp, i)
      if (JT[e] == "o") {
        t = cstr(ch(e, "target")); h = cstr(ch(e, "published")); ip = cstr(ch(e, "host_ip")); pr = cstr(ch(e, "protocol")); if (pr == "") pr = "tcp"
        v = t "/" pr
        if (h != "" || ip != "") { if (ip ~ /:/) ip = "[" ip "]"; v = (ip != "" ? ip ":" : "") h ":" v }
      } else v = JV[e]
      ports = ports (ports == "" ? "" : ",") jq(v)
    }
    vp = ch(sp, "volumes")
    for (i = 1; i <= JN[vp]; i++) {
      e = ch(vp, i)
      if (JT[e] == "o") {
        ty = cstr(ch(e, "type")); if (ty != "bind" && ty != "volume") continue
        v = rel(cstr(ch(e, "source"))) ":" cstr(ch(e, "target")); if (ctrue(ch(e, "read_only"))) v = v ":ro"
      } else v = JV[e]
      vols = vols (vols == "" ? "" : ",") jq(v)
    }
    np = ch(sp, "networks")
    if (has(np) && JT[np] == "o") { for (i = 1; i <= JN[np]; i++) nets = nets (nets == "" ? "" : ",") jq(JK[np, i]) }
    else if (has(np) && JT[np] == "a") { for (i = 1; i <= JN[np]; i++) nets = nets (nets == "" ? "" : ",") jq(JV[ch(np, i)]) }
    else if (!has(ch(sp, "network_mode"))) nets = jq("default")
    out = out (out == "" ? "" : ",") "{\"name\":" jq(nm) ",\"container_name\":" jq(cstr(ch(sp, "container_name"))) ",\"image\":" jq(cstr(ch(sp, "image"))) ",\"ports\":[" ports "],\"volumes\":[" vols "],\"networks\":[" nets "]}"
  }
  # the networks of the file, "default" first
  nn = ch(R, "networks"); allnets = ""
  if (has(ch(nn, "default"))) allnets = jq("default")
  for (i = 1; i <= JN[nn]; i++) { k = JK[nn, i]; if (k != "default") allnets = allnets (allnets == "" ? "" : ",") jq(k) }
  if (allnets == "" && no > 0) allnets = jq("default")
  w = ""
  while ((getline line < WARNFILE) > 0) if (line != "") w = w (w == "" ? "" : ",") jq(line)
  print "{\"services\":[" out "],\"networks\":[" allnets "],\"warnings\":[" w "]}"
}
BOSUN_AWK_END
awk -v CFGFILE="$tmp/cfg" -v WARNFILE="$tmp/warn" -v PROJ="$PD" -f "$tmp/prog.awk" "$CF" 2> "$tmp/awkerr" || fail "could not read the compose file: $(lasterr "$tmp/awkerr")"
exit 0
