#!/bin/sh
# Docker (Linux), dataset: the compose files of a Git repository branch, {"items":["docker-compose.yml","deploy/compose.yaml"]}:
# names docker-compose*.yml|yaml and compose*.yml|yaml, up to 3 folders deep, node_modules and .git ignored, the root first, then
# alphabetical. A shallow single-branch clone (depth 1) goes into a temporary folder that is removed afterwards; it only fetches the
# file tree (no file contents, nothing is checked out), so nothing of the repository can run and big repositories stay cheap (a git
# that does not know partial clones fetches the contents too). Links and submodules are not listed; only names that stack_deploy
# accepts (letters, digits and . _ / - only) are. Same https/host/token rules as stack_deploy. A failure prints `ERROR: message`
# (exit 0). Parameters: repo, branch.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
branch=$BOSUN_PARAM_branch
case "$branch" in ''|-*|*..*|*[!A-Za-z0-9._/-]*) fail 'branch: use letters, digits and . _ / - only' ;; esac
[ "${#branch}" -le 100 ] || fail 'branch: too long'
# >>> git helpers (the same text in git_branches.sh, git_files.sh and git_services.sh; a test compares them)
# Git over https only. Credentials (see "git credentials" below) go to the repository's own host only, through the environment of the
# git process (GIT_CONFIG_*), never on a command line, in a URL, in a file or in the output. Nothing of the repository is ever run: hooks are off, file:// and other protocols are refused, LFS is not smudged.
repo=$BOSUN_PARAM_repo
case "$repo" in https://*) ;; *) fail 'repo: use an https:// address' ;; esac
rr=${repo#https://}
case "$rr" in */*) ;; *) fail 'repo: use https://host/owner/name' ;; esac
rhost=${rr%%/*}; rpath=${rr#*/}
case "$rhost" in *@*) fail 'repo: invalid host' ;; esac
rport=''; case "$rhost" in *:*) rport=${rhost##*:}; rhost=${rhost%:*}; case "$rport" in ''|*[!0-9]*) fail 'repo: invalid port' ;; esac ;; esac
case "$rhost" in ''|-*|.*|*[!A-Za-z0-9.-]*|*..*) fail 'repo: invalid host' ;; esac
case "$rpath" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'repo: invalid path' ;; esac
[ "${#repo}" -le 300 ] || fail 'repo: too long'
command -v git >/dev/null 2>&1 || fail 'git is not installed on this host'
# >>> git credentials (the same text in stack_deploy.sh, stack_action.sh, git_branches.sh, git_files.sh and git_services.sh; a test compares them)
# Bosun exports the package secrets git_token (GitHub) and git_credentials (entries "host=token" or "host=user:token", host with its
# port when it has one, separated by spaces, commas or semicolons) only to scripts that name them. They are taken out of the
# environment at once, so git, docker and compose never inherit them. git_auth <https url> sets AUTH to the Basic Authorization header
# for exactly that repository's host, or '' when there is no credential for it; it reaches git only through gitrun's environment.
GIT_TOKEN=${BOSUN_SECRET_git_token-}; GIT_CREDENTIALS=${BOSUN_SECRET_git_credentials-}
unset BOSUN_SECRET_git_token BOSUN_SECRET_git_credentials
git_auth() {
  AUTH=''
  gh=${1#https://}; gh=${gh%%/*}; gh=$(printf '%s' "$gh" | tr 'A-Z' 'a-z')
  cred=''
  set -f
  for c in $(printf '%s' "$GIT_CREDENTIALS" | tr ',;' '  '); do
    case "$c" in *=*) [ "$(printf '%s' "${c%%=*}" | tr 'A-Z' 'a-z')" = "$gh" ] && cred=${c#*=} ;; esac
  done
  set +f
  if [ -z "$cred" ] && [ "$gh" = github.com ]; then cred=$GIT_TOKEN; fi
  [ -n "$cred" ] || return 0
  case "$cred" in *[!A-Za-z0-9_.~+/=:@-]*) cred=''; fail 'a Git credential has unexpected characters' ;; esac
  case "$cred" in
    *:*) pair=$cred ;;
    *) case "$gh" in github.com) u=x-access-token ;; bitbucket.org) u=x-token-auth ;; *gitlab*) u=oauth2 ;; *) u=git ;; esac; pair="$u:$cred" ;;
  esac
  if command -v base64 >/dev/null 2>&1; then b64=$(printf '%s' "$pair" | base64 | tr -d '\n')
  elif command -v openssl >/dev/null 2>&1; then b64=$(printf '%s' "$pair" | openssl base64 -A)
  else fail 'neither base64 nor openssl is available to prepare the Git credential'; fi
  AUTH="Authorization: Basic $b64"
  cred=''; pair=''; b64=''
}
# <<< git credentials
git_auth "$repo"
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
if ! gitrun clone --quiet --depth 1 --single-branch --no-checkout --filter=blob:none --branch "$branch" -- "$repo" "$tmp/repo" > /dev/null 2> "$tmp/err"; then
  rm -rf "$tmp/repo"
  # a git without partial clones: the same without the filter
  if ! gitrun clone --quiet --depth 1 --single-branch --no-checkout --branch "$branch" -- "$repo" "$tmp/repo" > /dev/null 2> "$tmp/err2"; then
    fail "git clone failed: $(lasterr "$tmp/err2")"
  fi
fi
# "<mode> <type> <sha><TAB><path>" for every file of the branch; links (120000) and submodules (160000) are skipped
if ! gitrun -C "$tmp/repo" ls-tree -r HEAD > "$tmp/tree" 2> "$tmp/err"; then fail "git could not list the files: $(lasterr "$tmp/err")"; fi
tr -d '\r' < "$tmp/tree" | awk -F '\t' '
  { split($1, m, " "); if (m[1] == "120000" || m[1] == "160000" || m[2] != "blob") next
    p = $2
    if (p !~ /^[A-Za-z0-9._\/-]+$/ || p ~ /\.\./ || p ~ /^-/ || p ~ /^\// || length(p) > 200) next
    if (p ~ /(^|\/)node_modules\// || p ~ /(^|\/)\.git\//) next
    n = split(p, parts, "/"); if (n > 4) next          # at most 3 folders deep
    f = parts[n]
    if (f !~ /^(docker-compose|compose)[^\/]*\.(yml|yaml)$/) next
    print (n > 1 ? "1" : "0") p }' | LC_ALL=C sort | cut -c2- | head -n 100 | awk '
  BEGIN { printf "{\"items\":[" }
  { if (NR > 1) printf ","; printf "\"%s\"", $0 }
  END { print "]}" }'
exit 0
