#!/bin/sh
# Docker (Linux): backs up one container or one Bosun-managed stack to the restic repository set in the Docker package's
# secrets (a local folder, SFTP or S3). The engine runs as a short-lived restic container, so nothing is installed on the host.
# What is included is chosen per run: named volumes (`volumes`), bind-mounted host folders (`binds`, sensitive paths are
# refused with the same rules as a stack deployment), the stored compose files of a Bosun stack (`stack_files`) and the
# image itself via docker save (`image`, off by default: large). A small metadata file per container records the image
# reference, image id, repo digest, the resolved version and `pinned_ref` (a version tag when the registry has one for
# exactly this digest, else repo@sha256:...), the labels and the mounts. `consistency` stop stops the container/stack
# while it is copied and always starts it again (a failure too). `keep_last`, `keep_daily`, `keep_weekly` and
# `keep_monthly` prune this container's/stack's own snapshots after the run.
# Parameters: kind (container|stack), name, volumes, binds, stack_files, image, consistency, keep_last, keep_daily,
# keep_weekly, keep_monthly.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
# >>> restic runner (the same text in backup_run.sh and backup_restore.sh; a test compares them)
# The backup engine runs as a short-lived container (nothing is installed on the host). The repository password, an SFTP
# private key and the S3 keys are written to files only this account can read and mounted read-only; they never appear on a
# command line or in the output. The destination, the password and the credentials are package secrets.
RESTIC_IMAGE=restic/restic:0.17.3
BACKUP_REPOSITORY=${BOSUN_SECRET_backup_repository-}
BACKUP_PASSWORD=${BOSUN_SECRET_backup_password-}
BACKUP_CREDENTIALS=${BOSUN_SECRET_backup_credentials-}
unset BOSUN_SECRET_backup_repository BOSUN_SECRET_backup_password BOSUN_SECRET_backup_credentials
RESTIC_STATE=''
RESTIC_DOCKER_ARGS=''
RESTIC_EXTRA_ARGS=''
RESTIC_REPO_ARG=''
restic_configured() { [ -n "$BACKUP_REPOSITORY" ] && [ -n "$BACKUP_PASSWORD" ]; }
restic_cleanup() { [ -z "$RESTIC_STATE" ] || rm -rf "$RESTIC_STATE"; RESTIC_STATE=''; }
restic_repo_display() { printf '%s' "$BACKUP_REPOSITORY"; }
restic_add_docker() { printf '%s\n' "$1" >> "$RESTIC_DOCKER_ARGS"; }
restic_add_extra() { printf '%s\n' "$1" >> "$RESTIC_EXTRA_ARGS"; }
restic_prepare() {
  [ -n "$RESTIC_STATE" ] && return 0
  restic_configured || fail 'the backup destination and password are not set (Settings -> Widgets -> Docker -> Secrets)'
  case "$BACKUP_REPOSITORY" in
    /*) case "$BACKUP_REPOSITORY" in *[[:cntrl:]]*|*..*) fail 'the backup destination is not a plain absolute path' ;; esac ;;
    sftp:*) case "$BACKUP_REPOSITORY" in *[[:cntrl:]]*) fail 'the backup destination has an unexpected character' ;; esac ;;
    s3:https://*) case "$BACKUP_REPOSITORY" in *[[:cntrl:]]*) fail 'the backup destination has an unexpected character' ;; esac ;;
    *) fail 'the backup destination must be an absolute folder, sftp:user@host:/path or s3:https://endpoint/bucket/prefix' ;;
  esac
  RESTIC_STATE=$(mktemp -d) || fail 'cannot create a temporary folder'
  chmod 700 "$RESTIC_STATE" 2>/dev/null
  RESTIC_DOCKER_ARGS="$RESTIC_STATE/docker-args"; : > "$RESTIC_DOCKER_ARGS"
  RESTIC_EXTRA_ARGS="$RESTIC_STATE/restic-args"; : > "$RESTIC_EXTRA_ARGS"
  printf '%s' "$BACKUP_PASSWORD" > "$RESTIC_STATE/password" || fail 'cannot prepare the repository password'
  chmod 600 "$RESTIC_STATE/password" 2>/dev/null
  unset BACKUP_PASSWORD
  restic_add_docker -e; restic_add_docker RESTIC_PASSWORD_FILE=/bosun/secret/password
  restic_add_docker -v; restic_add_docker "$RESTIC_STATE/password:/bosun/secret/password:ro"
  case "$BACKUP_REPOSITORY" in
    /*)
      mkdir -p "$BACKUP_REPOSITORY" 2>/dev/null || fail "the backup folder $BACKUP_REPOSITORY cannot be created"
      [ -d "$BACKUP_REPOSITORY" ] || fail "the backup folder $BACKUP_REPOSITORY is not a folder"
      restic_add_docker -v; restic_add_docker "$BACKUP_REPOSITORY:/bosun/repo"
      RESTIC_REPO_ARG=/bosun/repo ;;
    sftp:*)
      case "$BACKUP_CREDENTIALS" in
        /*) [ -f "$BACKUP_CREDENTIALS" ] || fail 'the SSH key file of the backup destination is missing'; cp "$BACKUP_CREDENTIALS" "$RESTIC_STATE/id" ;;
        '') fail 'an SSH key is needed for an SFTP backup destination (Settings -> Widgets -> Docker -> Secrets)' ;;
        *) if command -v base64 >/dev/null 2>&1; then printf '%s' "$BACKUP_CREDENTIALS" | base64 -d > "$RESTIC_STATE/id" 2>/dev/null
           elif command -v openssl >/dev/null 2>&1; then printf '%s' "$BACKUP_CREDENTIALS" | openssl base64 -d -A > "$RESTIC_STATE/id" 2>/dev/null
           else fail 'neither base64 nor openssl is available to read the SSH key of the backup destination'; fi
           [ -s "$RESTIC_STATE/id" ] || fail 'the SSH key of the backup destination is not valid base64' ;;
      esac
      chmod 600 "$RESTIC_STATE/id" 2>/dev/null
      : > "$RESTIC_STATE/known_hosts"
      restic_add_docker -v; restic_add_docker "$RESTIC_STATE:/bosun/secret"
      restic_add_extra -o
      restic_add_extra 'sftp.args=-i /bosun/secret/id -o UserKnownHostsFile=/bosun/secret/known_hosts -o StrictHostKeyChecking=accept-new'
      RESTIC_REPO_ARG=$BACKUP_REPOSITORY ;;
    s3:*)
      case "$BACKUP_CREDENTIALS" in
        *:*) ak=${BACKUP_CREDENTIALS%%:*}; sk=${BACKUP_CREDENTIALS#*:} ;;
        *) fail 'S3 credentials must be ACCESS_KEY:SECRET_KEY (Settings -> Widgets -> Docker -> Secrets)' ;;
      esac
      case "$ak" in ''|*[[:cntrl:]]*) fail 'the S3 access key has an unexpected character' ;; esac
      case "$sk" in ''|*[[:cntrl:]]*) fail 'the S3 secret key has an unexpected character' ;; esac
      { printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "$ak" "$sk"; } > "$RESTIC_STATE/aws" || fail 'cannot prepare the S3 credentials'
      chmod 600 "$RESTIC_STATE/aws" 2>/dev/null
      unset ak sk
      restic_add_docker -e; restic_add_docker AWS_SHARED_CREDENTIALS_FILE=/bosun/secret/aws
      restic_add_docker -v; restic_add_docker "$RESTIC_STATE/aws:/bosun/secret/aws:ro"
      RESTIC_REPO_ARG=$BACKUP_REPOSITORY ;;
  esac
  unset BACKUP_CREDENTIALS
  if ! $D image inspect "$RESTIC_IMAGE" >/dev/null 2>&1; then
    echo '[step] Pulling the backup engine'
    $D pull "$RESTIC_IMAGE" >/dev/null 2>&1 || fail 'the backup engine could not be pulled (restic/restic:0.17.3)'
  fi
}
restic_run() {
  : > "$RESTIC_STATE/restic-cmd" || fail 'cannot prepare a restic call'
  [ $# -eq 0 ] || printf '%s\n' "$@" > "$RESTIC_STATE/restic-cmd"
  set --
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_DOCKER_ARGS"
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_EXTRA_ARGS"
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_STATE/restic-cmd"
  $D run --rm --name "bosun-restic-$$" --label bosun.backup=1 "$@"
}
restic_shell() { # $1 = the shell command; the remaining arguments become $1, $2 ... in it
  shell_cmd=$1; shift
  : > "$RESTIC_STATE/restic-cmd" || fail 'cannot prepare a restic call'
  [ $# -eq 0 ] || printf '%s\n' "$@" > "$RESTIC_STATE/restic-cmd"
  set --
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_DOCKER_ARGS"
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_EXTRA_ARGS"
  set -- "$@" --entrypoint /bin/sh "$RESTIC_IMAGE" -c "$shell_cmd" sh
  while IFS= read -r a; do set -- "$@" "$a"; done < "$RESTIC_STATE/restic-cmd"
  $D run --rm --name "bosun-restic-$$" --label bosun.backup=1 "$@"
}
# <<< restic runner
# >>> backup settings (a small key=value text blob, the same shape the container editor uses)
mode=${BOSUN_PARAM_mode:-run}; kind=${BOSUN_PARAM_kind:-container}; name=$BOSUN_PARAM_name
SETTINGS=$BOSUN_PARAM_settings
case "$mode" in run|init) ;; *) fail 'mode must be run or init' ;; esac
case "$kind" in container|stack) ;; *) fail 'kind must be container or stack' ;; esac
volumes=true; binds=true; stack_files=true; image=false; consistency=live
keep_last=0; keep_daily=7; keep_weekly=4; keep_monthly=6
SEEN=' '
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in \#*) continue ;; esac
  k=${line%%=*}; v=${line#*=}
  case "$k" in ''|*[!a-z_]*) fail "the backup settings are damaged (near '$line')" ;; esac
  case "$SEEN" in *" $k "*) fail "the setting $k appears twice" ;; esac
  SEEN="$SEEN$k "
  case "$k" in
    volumes|binds|stack_files|image) case "$v" in true|false) ;; '') continue ;; *) fail "$k must be true or false" ;; esac ;;
    consistency) case "$v" in live|stop) ;; '') continue ;; *) fail 'consistency must be live or stop' ;; esac ;;
    keep_last|keep_daily|keep_weekly|keep_monthly) case "$v" in ''|*[!0-9]*) [ -z "$v" ] && continue; fail 'the retention values must be whole numbers' ;; esac; [ "${#v}" -le 5 ] || fail 'the retention values are too large' ;;
    *) fail "unknown backup setting '$k'" ;;
  esac
  case "$k" in
    volumes) volumes=$v ;; binds) binds=$v ;; stack_files) stack_files=$v ;; image) image=$v ;;
    consistency) consistency=$v ;;
    keep_last) keep_last=$v ;; keep_daily) keep_daily=$v ;; keep_weekly) keep_weekly=$v ;; keep_monthly) keep_monthly=$v ;;
  esac
done <<EOS
$SETTINGS
EOS
if [ "$mode" = run ]; then
  case "$name" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'invalid container or stack name' ;; esac
  [ "${#name}" -le 128 ] || fail 'invalid container or stack name'
fi
# <<< backup settings
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
# >>> sensitive paths (the same rules as stack_action.sh: the folder itself, anything inside it, or a folder that contains it)
sensitive() {
  P=$1 awk 'BEGIN {
    n = split(ENVIRON["P"], a, "/"); k = 0
    for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (k > 0) k--; continue } k++; s[k] = a[i] }
    if (k == 0) exit 0
    p = ""; for (i = 1; i <= k; i++) p = p "/" s[i]
    b = tolower(s[k]); if (b ~ /(docker|containerd|crio|podman)\.sock$/) exit 0
    n = split("/etc /root /proc /sys /dev /boot /usr /bin /sbin /lib /lib32 /lib64 /libx32 /run /var/run /var/lib/docker /var/lib/containerd /var/lib/kubelet /var/spool/cron", r, " ")
    for (i = 1; i <= n; i++) if (p == r[i] || index(p, r[i] "/") == 1 || index(r[i], p "/") == 1) exit 0
    if (s[1] == "home" && (k <= 2 || substr(s[3], 1, 1) == ".")) exit 0
    exit 1 }'
}
host_path_sensitive() {
  sensitive "$1" && return 0
  hp=$(readlink -f -- "$1" 2>/dev/null)
  [ -n "$hp" ] && [ "$hp" != "$1" ] && sensitive "$hp" && return 0
  return 1
}
# <<< sensitive paths
jstr() { V=$1 awk 'BEGIN { s = ENVIRON["V"]; o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } printf "\"%s\"", o }'; }
lastline() { [ -f "$1" ] || return 0; tr -d '\r' < "$1" 2>/dev/null | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400; }
human_bytes() { B=$1 awk 'BEGIN { b = ENVIRON["B"] + 0; split("B KiB MiB GiB TiB PiB", u, " "); i = 1; while (b >= 1024 && i < 6) { b = b / 1024; i++ } if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i] }'; }
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S'; }
# The repository of an image reference (docker.io/library and the index names dropped, the tag removed).
repo_of() {
  r=$1
  case "$r" in *@*) r=${r%%@*} ;; esac
  case "$r" in
    */*) pre=${r%/*}; base=${r##*/}; case "$base" in *:*) base=${base%%:*} ;; esac; r="$pre/$base" ;;
    *) case "$r" in *:*) r=${r%%:*} ;; esac ;;
  esac
  r=${r#index.docker.io/}; r=${r#registry-1.docker.io/}; r=${r#docker.io/}; r=${r#library/}
  printf '%s' "$r"
}
digest_of() { # $1 = RepoDigests JSON, $2 = repo; prints repo@sha256:... or ''
  printf '%s' "$1" | tr ',' '\n' | tr -d '[]" ' | awk -v r="$2" 'NF && index($0, r "@") == 1 { print; exit }'
}
http_get() { # $1 = url, $2 = token (may be empty)
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$2" ]; then curl -fsSL --max-time 5 -H "Authorization: Bearer $2" "$1" 2>/dev/null
    else curl -fsSL --max-time 5 "$1" 2>/dev/null; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$2" ]; then wget -q -T 5 --header="Authorization: Bearer $2" -O - "$1" 2>/dev/null
    else wget -q -T 5 -O - "$1" 2>/dev/null; fi
  fi
}
http_head() { # $1 = url, $2 = token (may be empty); prints the Docker-Content-Digest header
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$2" ]; then curl -fsSI --max-time 5 -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" -H "Authorization: Bearer $2" "$1" 2>/dev/null
    else curl -fsSI --max-time 5 -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" "$1" 2>/dev/null; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$2" ]; then wget -q -T 5 -S --spider --header="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" --header="Authorization: Bearer $2" "$1" 2>&1
    else wget -q -T 5 -S --spider --header="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" "$1" 2>&1; fi
  fi
}
# A version-looking tag (1.2.3, v1.2, 2024.10.1, 1.2.3-alpine) is preferred over a moving name such as latest.
is_version_tag() { printf '%s' "$1" | grep -Eq '^v?[0-9]+(\.[0-9]+)*(-[A-Za-z0-9.]+)?$' 2>/dev/null; }
choose_version() { awk '
  function key(s,   a, n, i, k) { sub(/^v/, "", s); sub(/[-+].*/, "", s); n = split(s, a, "."); k = ""; for (i = 1; i <= n; i++) k = k sprintf("%06d", a[i] + 0); return k }
  NF { k = key($0); if (best == "" || k > best) { best = k; tag = $0 } }
  END { if (tag != "") print tag }'; }
registry_tag() { # $1 = repo, $2 = digest; prints a tag whose manifest digest is $2, or ''
  case "$1" in */*) first=${1%%/*}; rest=${1#*/}
      case "$first" in *.*|*:*|localhost) reg=$first; rpath=$rest ;; *) reg=registry-1.docker.io; rpath=$1 ;; esac ;;
    *) reg=registry-1.docker.io; rpath=library/$1 ;;
  esac
  tok=''
  if [ "$reg" = registry-1.docker.io ]; then
    tok=$(http_get "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$rpath:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    [ -n "$tok" ] || return 0
  fi
  list=$(http_get "https://$reg/v2/$rpath/tags/list" "$tok")
  [ -n "$list" ] || return 0
  tags=$(printf '%s' "$list" | sed -n 's/.*"tags"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '" ')
  [ -n "$tags" ] || return 0
  # the newest 50 names: the registry gives no order, so read the list backwards and stop after 50 or 15 seconds
  tags=$(printf '%s\n' "$tags" | awk '{ a[NR] = $0 } END { n = 0; for (i = NR; i >= 1 && n < 50; i--) { if (a[i] != "") { print a[i]; n++ } } }')
  start=$(date +%s 2>/dev/null || echo 0)
  matches=''
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    case "$t" in *[!A-Za-z0-9_.-]*) continue ;; esac
    if [ "$start" -gt 0 ]; then [ $(( $(date +%s) - start )) -le 15 ] || break; fi
    d=$(http_head "https://$reg/v2/$rpath/manifests/$t" "$tok" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest:[[:space:]]*//p' | head -n 1)
    [ "$d" = "$2" ] && matches="$matches$t
"
  done <<EOS
$tags
EOS
  versions=''
  while IFS= read -r t; do [ -n "$t" ] && is_version_tag "$t" && versions="$versions$t
"; done <<EOS
$matches
EOS
  [ -n "$versions" ] || return 0
  printf '%s' "$versions" | choose_version
}
resolve_version() { # $1 = image id, $2 = image ref, $3 = RepoDigests JSON, $4 = version label
  RV_REPO=''; RV_DIGEST=''; RV_RESOLVED=''; RV_PINNED=''; RV_SOURCE=''
  case "$2" in ''|sha256:*|*[!A-Za-z0-9._/:@-]*) RV_REPO='' ;; *) RV_REPO=$(repo_of "$2") ;; esac
  d=$(digest_of "$3" "$RV_REPO")
  if [ -z "$d" ]; then d=$(printf '%s' "$3" | tr ',' '\n' | tr -d '[]" ' | sed -n 's/^.*@//p' | head -n 1); fi
  case "$d" in *@*) RV_DIGEST=${d#*@} ;; *) RV_DIGEST=$d ;; esac
  case "$RV_DIGEST" in sha256:[0-9a-f]*) ;; *) RV_DIGEST='' ;; esac
  case "$4" in
    ''|*[!A-Za-z0-9_.-]*) ;;
    [!A-Za-z0-9_]*) ;;
    *) if [ -n "$RV_REPO" ]; then RV_RESOLVED=$4; RV_PINNED="$RV_REPO:$4"; RV_SOURCE=label; fi ;;
  esac
  if [ -z "$RV_PINNED" ] && [ -n "$RV_REPO" ] && [ -n "$RV_DIGEST" ]; then
    t=$(registry_tag "$RV_REPO" "$RV_DIGEST")
    if [ -n "$t" ]; then RV_RESOLVED=$t; RV_PINNED="$RV_REPO:$t"; RV_SOURCE=registry
    else RV_RESOLVED=$RV_DIGEST; RV_PINNED="$RV_REPO@$RV_DIGEST"; RV_SOURCE=digest; fi
  fi
  if [ -z "$RV_PINNED" ] && [ -n "$RV_DIGEST" ]; then RV_RESOLVED=$RV_DIGEST; RV_PINNED=$RV_DIGEST; RV_SOURCE=digest; fi
  [ -n "$RV_RESOLVED" ] || RV_RESOLVED=${2:-$1}
}
STOPPED=''
start_stopped() {
  [ -z "$STOPPED" ] && return 0
  for c in $STOPPED; do $D start "$c" >/dev/null 2>&1; done
  STOPPED=''
}
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'start_stopped; rm -rf "$tmp"; restic_cleanup' EXIT
mkdir -p "$tmp/meta" "$tmp/versions" || fail 'cannot prepare the backup'
: > "$tmp/meta/restore_map"; : > "$tmp/meta/pinned_map"
restic_prepare
if [ "$mode" = init ]; then
  echo 'PROGRESS 0/2'
  echo '[step] Checking the backup repository'
  errf="$tmp/init.err"
  if restic_run -r "$RESTIC_REPO_ARG" cat config >/dev/null 2>"$errf"; then
    echo 'PROGRESS 2/2'
    echo "DONE the backup repository $(restic_repo_display) is already initialised"
    exit 0
  fi
  echo 'PROGRESS 1/2'
  echo "[step] Initialising the backup repository $(restic_repo_display)"
  if ! restic_run -r "$RESTIC_REPO_ARG" init >/dev/null 2>"$errf"; then
    fail "initialising the backup repository failed: $(lastline "$errf")"
  fi
  echo 'PROGRESS 2/2'
  echo 'DONE backup repository ready; store its password somewhere safe, without it the backups cannot be read'
  exit 0
fi
echo 'PROGRESS 0/4'
echo "[step] Reading the $kind $name"
CNAMES=''; CIDX=0; HAS_DATA=0; HAS_FILES=0; HAS_IMAGES=0; BYTES=0
PINS=''; VERSIONS=''
if [ "$kind" = container ]; then
  facts=$($D inspect --type container --format 'ID {{.Id}}
RUN {{.State.Running}}' "$name" 2>/dev/null) || fail "the container $name was not found"
  cid=$(printf '%s\n' "$facts" | sed -n 's/^ID //p')
  run=$(printf '%s\n' "$facts" | sed -n 's/^RUN //p')
  case "$cid" in ''|*[!0-9a-f]*) fail "the container $name could not be read" ;; esac
  CNAMES=$name
  if [ "$consistency" = stop ] && [ "$run" = true ]; then
    echo "[step] Stopping the container $name for a consistent backup"
    $D stop "$cid" >/dev/null 2>&1 || fail "the container $name could not be stopped"
    STOPPED="$STOPPED $cid"
  fi
else
  ids=$($D ps -aq --filter "label=com.docker.compose.project=$name" 2>/dev/null)
  for cid in $ids; do
    c=$($D inspect --type container --format '{{.Name}}' "$cid" 2>/dev/null); c=${c#/}
    case "$c" in ''|*[!A-Za-z0-9_.-]*) continue ;; esac
    CNAMES="$CNAMES $c"
  done
  if [ "$consistency" = stop ]; then
    for cid in $ids; do
      run=$($D inspect --type container --format '{{.State.Running}}' "$cid" 2>/dev/null)
      if [ "$run" = true ]; then
        echo "[step] Stopping the stack $name for a consistent backup"
        $D stop "$cid" >/dev/null 2>&1 || fail "a container of the stack $name could not be stopped"
        STOPPED="$STOPPED $cid"
      fi
    done
  fi
fi
echo 'PROGRESS 1/4'
echo '[step] Collecting the container data'
for cname in $CNAMES; do
  facts=$($D inspect --type container --format 'ID {{.Id}}
REF {{.Config.Image}}
IMGID {{.Image}}
PROJ {{with .Config.Labels}}{{index . "com.docker.compose.project"}}{{end}}
SVC {{with .Config.Labels}}{{index . "com.docker.compose.service"}}{{end}}' "$cname" 2>/dev/null) || fail "the container $cname could not be read"
  cid=$(printf '%s\n' "$facts" | sed -n 's/^ID //p')
  ref=$(printf '%s\n' "$facts" | sed -n 's/^REF //p')
  imgid=$(printf '%s\n' "$facts" | sed -n 's/^IMGID //p')
  proj=$(printf '%s\n' "$facts" | sed -n 's/^PROJ //p')
  svc=$(printf '%s\n' "$facts" | sed -n 's/^SVC //p')
  case "$cid" in ''|*[!0-9a-f]*) fail "the container $cname could not be read" ;; esac
  labels=$($D inspect --type container --format '{{json .Config.Labels}}' "$cname" 2>/dev/null)
  case "$labels" in \{*) ;; *) labels='{}' ;; esac
  # The image facts and the resolved version are cached per image id (a stack often runs one image in several services).
  vfile="$tmp/versions/$imgid"
  case "$imgid" in ''|*[!0-9a-zA-Z:]*) vfile='' ;; esac
  if [ -n "$vfile" ] && [ -f "$vfile" ]; then
    RV_REPO=$(sed -n 's/^REPO //p' "$vfile"); RV_DIGEST=$(sed -n 's/^DIGEST //p' "$vfile")
    RV_RESOLVED=$(sed -n 's/^RESOLVED //p' "$vfile"); RV_PINNED=$(sed -n 's/^PINNED //p' "$vfile"); RV_SOURCE=$(sed -n 's/^SOURCE //p' "$vfile")
  else
    repodigests=$($D image inspect --format '{{json .RepoDigests}}' "$imgid" 2>/dev/null)
    vlabel=$($D image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.version"}}{{end}}' "$imgid" 2>/dev/null)
    resolve_version "$imgid" "$ref" "$repodigests" "$vlabel"
    if [ -n "$vfile" ]; then
      { printf 'REPO %s\nDIGEST %s\nRESOLVED %s\nPINNED %s\nSOURCE %s\n' "$RV_REPO" "$RV_DIGEST" "$RV_RESOLVED" "$RV_PINNED" "$RV_SOURCE"; } > "$vfile"
    fi
  fi
  case "$RV_PINNED" in '') ;; *) case "$PINS" in *" $RV_PINNED "*) ;; *) PINS="$PINS $RV_PINNED " ;; esac ;; esac
  case "$RV_RESOLVED" in '') ;; *) case "$VERSIONS" in *" $RV_RESOLVED "*) ;; *) VERSIONS="$VERSIONS $RV_RESOLVED " ;; esac ;; esac
  # The mounts to copy, as tab-separated lines (a value with a tab or a newline is refused rather than misread).
  mounts=$($D inspect --type container --format '{{range .Mounts}}{{.Type}}{{"\t"}}{{.Name}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\t"}}{{.RW}}{{"\n"}}{{end}}' "$cname" 2>/dev/null)
  mountjson=''; nmount=0; nm=0; nb=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    mt=$(printf '%s' "$line" | awk -F '\t' 'NF == 5 { print $1 }')
    [ -n "$mt" ] || fail "a mount of $cname could not be read (a path with a tab or a newline is not supported)"
    mname=$(printf '%s' "$line" | awk -F '\t' 'NF == 5 { print $2 }')
    msrc=$(printf '%s' "$line" | awk -F '\t' 'NF == 5 { print $3 }')
    mdst=$(printf '%s' "$line" | awk -F '\t' 'NF == 5 { print $4 }')
    mrw=$(printf '%s' "$line" | awk -F '\t' 'NF == 5 { print $5 }')
    case "$mt" in
      volume)
        [ "$volumes" = true ] || continue
        case "$mname" in ''|*[!A-Za-z0-9_.-]*) fail "a volume name of $cname is not supported" ;; esac
        msrc=$mname ;;
      bind)
        [ "$binds" = true ] || continue
        case "$msrc" in /*) ;; *) fail "a bind mount of $cname is not an absolute host path" ;; esac
        if host_path_sensitive "$msrc"; then fail "the bind folder $msrc of $cname is a sensitive host path and is not backed up"; fi ;;
      *) continue ;;
    esac
    case "$mdst" in /*) ;; *) fail "a mount destination of $cname is not an absolute path" ;; esac
    case "$mt" in volume) nm=$((nm + 1)); target="$CIDX-v$nm" ;; *) nb=$((nb + 1)); target="$CIDX-b$nb" ;; esac
    restic_add_docker -v; restic_add_docker "$msrc:/bosun/data/$target:ro"
    HAS_DATA=1
    if [ "$mrw" = true ]; then ro=true; else ro=false; fi
    mountjson="$mountjson${mountjson:+,}{\"type\":$(jstr "$mt"),\"source\":$(jstr "$msrc"),\"destination\":$(jstr "$mdst"),\"target\":$(jstr "/bosun/data/$target"),\"read_only\":$ro}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cname" "$mt" "$msrc" "$mdst" "$mrw" "/bosun/data/$target" >> "$tmp/meta/restore_map"
    nmount=$((nmount + 1))
  done <<EOS
$mounts
EOS
  if [ -n "$RV_PINNED" ]; then printf '%s\t%s\t%s\t%s\n' "$cname" "${svc:--}" "$RV_PINNED" "$RV_RESOLVED" >> "$tmp/meta/pinned_map"; fi
  if [ "$kind" = stack ]; then mstack=$name; msvc=${svc:-$cname}; else mstack=$proj; msvc=$svc; fi
  if [ "$kind" = stack ] && [ "$stack_files" = true ]; then inc_files=true; else inc_files=false; fi
  {
    printf '{"kind":%s,"name":%s,"container":%s,"stack":%s,"service":%s,"created":%s' \
      "$(jstr "$kind")" "$(jstr "$name")" "$(jstr "$cname")" "$(jstr "$mstack")" "$(jstr "$msvc")" "$(jstr "$(now_iso)")"
    printf ',"image":%s,"image_id":%s,"repo":%s,"repo_digest":%s' "$(jstr "$ref")" "$(jstr "$imgid")" "$(jstr "$RV_REPO")" "$(jstr "$RV_DIGEST")"
    printf ',"resolved_version":%s,"pinned_ref":%s,"version_source":%s' "$(jstr "$RV_RESOLVED")" "$(jstr "$RV_PINNED")" "$(jstr "$RV_SOURCE")"
    printf ',"labels":%s,"mounts":[%s],"included":{"volumes":%s,"binds":%s,"stack_files":%s,"image":%s}}' \
      "$labels" "$mountjson" "$volumes" "$binds" "$inc_files" "$image"
  } > "$tmp/meta/$cname.json" || fail "the metadata of $cname could not be written"
  CIDX=$((CIDX + 1))
done
# The stored compose files of a Bosun-managed stack (never an external one, whose files only docker compose knows).
if [ "$kind" = stack ] && [ "$stack_files" = true ]; then
  DIR="$HOME/bosun-stacks/$name"
  if [ -d "$DIR" ]; then
    meta_get() { [ -f "$DIR/bosun.meta" ] || return 0; while IFS= read -r l; do case "$l" in "$1="*) printf '%s' "${l#*=}"; return 0 ;; esac; done < "$DIR/bosun.meta"; }
    mkdir -p "$tmp/stack" || fail 'cannot prepare the stack files'
    if [ "$(meta_get source)" = git ]; then
      f=$(meta_get file)
      case "$f" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail "the stored stack record of $name is damaged" ;; esac
      cf="$DIR/repo/$f"
      if [ -L "$cf" ] || [ ! -f "$cf" ]; then fail "the compose file of the stack $name is missing or a link out of the checkout"; fi
    else cf="$DIR/compose.yaml"; fi
    if [ -f "$cf" ]; then cp "$cf" "$tmp/stack/compose.yaml" || fail 'the compose file could not be copied'; HAS_FILES=1; fi
    [ ! -f "$DIR/.env" ] || { cp "$DIR/.env" "$tmp/stack/.env" || fail 'the .env file could not be copied'; HAS_FILES=1; }
    [ ! -f "$DIR/compose.override.yaml" ] || { cp "$DIR/compose.override.yaml" "$tmp/stack/compose.override.yaml" || fail 'the override file could not be copied'; HAS_FILES=1; }
    [ ! -f "$DIR/bosun.override" ] || { cp "$DIR/bosun.override" "$tmp/stack/bosun.override" || fail 'the override text could not be copied'; HAS_FILES=1; }
    { printf '{"kind":"stack","name":%s,"source":%s,"repo":%s,"branch":%s,"file":%s,"created":%s}' \
        "$(jstr "$name")" "$(jstr "$(meta_get source)")" "$(jstr "$(meta_get repo)")" "$(jstr "$(meta_get branch)")" "$(jstr "$(meta_get file)")" "$(jstr "$(now_iso)")"; } > "$tmp/stack/bosun.json"
  fi
fi
# The image itself, when asked for (docker save; large).
if [ "$image" = true ]; then
  mkdir -p "$tmp/images" || fail 'cannot prepare the image export'
  for cname in $CNAMES; do
    imgid=$($D inspect --type container --format '{{.Image}}' "$cname" 2>/dev/null)
    case "$imgid" in ''|*[!0-9a-zA-Z:]*) fail "the image of $cname could not be read" ;; esac
    echo "[step] Saving the image of $cname"
    $D save -o "$tmp/images/$cname.tar" "$imgid" >/dev/null 2>&1 || fail "the image of $cname could not be saved"
    HAS_IMAGES=1
  done
fi
if [ "$HAS_DATA" -eq 0 ] && [ "$HAS_FILES" -eq 0 ] && [ "$HAS_IMAGES" -eq 0 ]; then
  fail 'nothing to back up: choose the volumes, the mapped folders, the stack files or the image'
fi
restic_add_docker -v; restic_add_docker "$tmp/meta:/bosun/meta:ro"
[ "$HAS_FILES" -eq 0 ] || { restic_add_docker -v; restic_add_docker "$tmp/stack:/bosun/stack:ro"; }
[ "$HAS_IMAGES" -eq 0 ] || { restic_add_docker -v; restic_add_docker "$tmp/images:/bosun/images:ro"; }
echo 'PROGRESS 2/4'
echo "[step] Measuring the data"
kb=$(restic_shell 'du -sk /bosun/data /bosun/stack /bosun/images 2>/dev/null | awk "{ s += \$1 } END { print s + 0 }"' 2>/dev/null | tail -n 1)
case "$kb" in ''|*[!0-9]*) kb=0 ;; esac
BYTES=$((kb * 1024))
echo "[step] Copying to the repository $(restic_repo_display)"
set -- backup
[ "$HAS_DATA" -eq 0 ] || set -- "$@" /bosun/data
set -- "$@" /bosun/meta
[ "$HAS_FILES" -eq 0 ] || set -- "$@" /bosun/stack
[ "$HAS_IMAGES" -eq 0 ] || set -- "$@" /bosun/images
set -- "$@" --host bosun --json --tag "bosun:kind=$kind"
if [ "$kind" = container ]; then set -- "$@" --tag "bosun:container=$name"; else set -- "$@" --tag "bosun:stack=$name"; fi
[ "$volumes" = true ] && set -- "$@" --tag bosun:volumes=1
[ "$binds" = true ] && set -- "$@" --tag bosun:binds=1
[ "$kind" = stack ] && [ "$stack_files" = true ] && set -- "$@" --tag bosun:files=1
[ "$image" = true ] && set -- "$@" --tag bosun:image=1
[ "$BYTES" -le 0 ] || set -- "$@" --tag "bosun:bytes=$BYTES"
for p in $PINS; do [ -n "$p" ] && set -- "$@" --tag "bosun:pinned=$p"; done
for v in $VERSIONS; do [ -n "$v" ] && set -- "$@" --tag "bosun:version=$v"; done
outf="$tmp/restic.out"; errf="$tmp/restic.err"
if ! restic_run -r "$RESTIC_REPO_ARG" "$@" > "$outf" 2> "$errf"; then
  if [ -s "$errf" ]; then fail "the backup failed: $(lastline "$errf")"; fi
  fail "the backup failed: $(lastline "$outf")"
fi
sid=$(sed -n 's/.*"snapshot_id"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{8,\}\)".*/\1/p' "$outf" | tail -n 1)
if [ -z "$sid" ]; then
  sid=$(restic_run -r "$RESTIC_REPO_ARG" snapshots --latest 1 --json --tag "bosun:$kind=$name" 2>/dev/null | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{8,\}\)".*/\1/p' | tail -n 1)
fi
echo 'PROGRESS 3/4'
echo '[step] Applying the retention'
set -- forget --prune --tag "bosun:$kind=$name"
[ "$keep_last" -eq 0 ] || set -- "$@" --keep-last "$keep_last"
[ "$keep_daily" -eq 0 ] || set -- "$@" --keep-daily "$keep_daily"
[ "$keep_weekly" -eq 0 ] || set -- "$@" --keep-weekly "$keep_weekly"
[ "$keep_monthly" -eq 0 ] || set -- "$@" --keep-monthly "$keep_monthly"
if ! restic_run -r "$RESTIC_REPO_ARG" "$@" >/dev/null 2> "$errf"; then
  echo "[step] The backup is safe, but the retention could not be applied: $(lastline "$errf")"
fi
start_stopped
echo 'PROGRESS 4/4'
short=$(printf '%s' "$sid" | cut -c1-8)
if [ -n "$sid" ]; then echo "DONE backed up $kind $name (snapshot $short)"; else echo "DONE backed up $kind $name"; fi
exit 0
