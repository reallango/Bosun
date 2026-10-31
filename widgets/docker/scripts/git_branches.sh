#!/bin/sh
# Docker (Linux), dataset: the branches of a Git repository, the default one first, then alphabetical:
#   {"items":[{"name":"main","default":true},{"name":"dev","default":false}]}
# `git ls-remote --symref` over https (same host, path and token rules as stack_deploy: the token is only used for github.com and only
# through the environment of git). Branch names that stack_deploy would refuse (letters, digits and . _ / - only) are left out.
# At most 200 branches. Nothing is cloned or stored. A failure prints `ERROR: message` (exit 0). Parameter: repo.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
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

tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
if ! gitrun ls-remote --symref -- "$repo" HEAD 'refs/heads/*' > "$tmp/out" 2> "$tmp/err"; then
  fail "git could not read the repository: $(lasterr "$tmp/err")"
fi
# lines: "ref: refs/heads/main<TAB>HEAD" (the default branch), "<sha><TAB>HEAD", "<sha><TAB>refs/heads/<name>"
tr -d '\r' < "$tmp/out" | awk -F '\t' '
  $1 ~ /^ref: refs\/heads\// && $2 == "HEAD" { d = $1; sub(/^ref: refs\/heads\//, "", d); def = d; next }
  $2 == "HEAD" { headsha = $1; next }
  $2 ~ /^refs\/heads\// {
    n = $2; sub(/^refs\/heads\//, "", n)
    if (n !~ /^[A-Za-z0-9._\/-]+$/ || n ~ /\.\./ || n ~ /^-/ || length(n) > 100) next
    if (!(n in sha)) { cnt++; names[cnt] = n }
    sha[n] = $1
  }
  END {
    # without a symref line (an old git) the default is the branch HEAD points at: main or master first
    if (def == "" && headsha != "") {
      if (("main" in sha) && sha["main"] == headsha) def = "main"
      else if (("master" in sha) && sha["master"] == headsha) def = "master"
      else for (i = 1; i <= cnt; i++) if (sha[names[i]] == headsha) { def = names[i]; break }
    }
    # alphabetical order of the others (a simple insertion sort: at most a few hundred names)
    for (i = 2; i <= cnt; i++) { t = names[i]; j = i - 1; while (j >= 1 && names[j] > t) { names[j + 1] = names[j]; j-- } names[j + 1] = t }
    out = ""; k = 0
    if (def != "" && (def in sha)) { out = "{\"name\":\"" def "\",\"default\":true}"; k = 1 }
    for (i = 1; i <= cnt && k < 200; i++) { if (names[i] == def) continue; out = out (k ? "," : "") "{\"name\":\"" names[i] "\",\"default\":false}"; k++ }
    print "{\"items\":[" out "]}"
  }'
exit 0
