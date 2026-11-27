#!/bin/sh
# Docker (Linux): lists the backups of containers and stacks, restores one snapshot and deletes one snapshot. `list` (a
# dataset) prints the snapshots with their time, size, what they included and the pinned image version, and the state of the
# repository. `restore` stops the container/stack, restores the data into the volumes and bind folders recorded in the
# snapshot, and starts it again (always, a failure too); with `pin_image` it then recreates a standalone container or
# redeploys a Bosun-managed stack on the image version the backup recorded. `restore_mode` `new_volume` restores into new
# volumes and folders instead (nothing running is touched), so the backup can be inspected first. `forget` removes one
# snapshot and prunes. Parameters: mode, kind, name, snapshot, pin_image, restore_mode.
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
mode=${BOSUN_PARAM_mode:-list}; kind=${BOSUN_PARAM_kind:-all}
name=$BOSUN_PARAM_name; [ "$name" = - ] && name=
snapshot=$BOSUN_PARAM_snapshot; [ "$snapshot" = - ] && snapshot=
SETTINGS=$BOSUN_PARAM_settings
pin_image=false; restore_mode=replace
SEEN=' '
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in \#*) continue ;; esac
  k=${line%%=*}; v=${line#*=}
  case "$k" in ''|*[!a-z_]*) fail "the restore settings are damaged (near '$line')" ;; esac
  case "$SEEN" in *" $k "*) fail "the setting $k appears twice" ;; esac
  SEEN="$SEEN$k "
  case "$k" in
    pin_image) case "$v" in true|false) ;; '') continue ;; *) fail 'pin_image must be true or false' ;; esac; pin_image=$v ;;
    restore_mode) case "$v" in replace|new_volume) ;; '') continue ;; *) fail 'restore_mode must be replace or new_volume' ;; esac; restore_mode=$v ;;
    mode) ;; # the screen's select is sent here too; the action parameter carries it
    *) fail "unknown restore setting '$k'" ;;
  esac
done <<EOS
$SETTINGS
EOS
case "$mode" in list|restore|forget) ;; *) fail 'mode must be list, restore or forget' ;; esac
case "$kind" in all|container|stack) ;; *) fail 'kind must be all, container or stack' ;; esac
case "$pin_image" in true|false) ;; *) fail 'pin_image must be true or false' ;; esac
case "$restore_mode" in replace|new_volume) ;; *) fail 'restore_mode must be replace or new_volume' ;; esac
if [ "$mode" != list ]; then
  case "$kind" in container|stack) ;; *) fail 'a restore or a delete needs kind container or stack' ;; esac
  case "$name" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'invalid container or stack name' ;; esac
  [ "${#name}" -le 128 ] || fail 'invalid container or stack name'
  case "$snapshot" in [0-9a-f]*) ;; *) fail 'invalid snapshot id' ;; esac
  [ "${#snapshot}" -ge 8 ] && [ "${#snapshot}" -le 64 ] || fail 'invalid snapshot id'
fi
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
jstr() { V=$1 awk 'BEGIN { s = ENVIRON["V"]; o = ""; n = length(s); for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } printf "\"%s\"", o }'; }
if ! $D ps >/dev/null 2>&1; then
  if [ "$mode" = list ]; then
    printf '{"status":{"configured":%s,"initialised":false,"repository":%s,"snapshots":0,"size":"","size_bytes":0,"state":"Unavailable","message":"Docker is not available to this account"},"rows":[]}\n' \
      "$(restic_configured && echo true || echo false)" "$(jstr "$BACKUP_REPOSITORY")"
    exit 0
  fi
  echo 'ERROR: Docker is not available to this account'; exit 0
fi
lastline() { [ -f "$1" ] || return 0; tr -d '\r' < "$1" 2>/dev/null | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400; }
human_bytes() { B=$1 awk 'BEGIN { b = ENVIRON["B"] + 0; split("B KiB MiB GiB TiB PiB", u, " "); i = 1; while (b >= 1024 && i < 6) { b = b / 1024; i++ } if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i] }'; }
now_stamp() { date '+%Y%m%d%H%M%S' 2>/dev/null || echo $$; }
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
# >>> pinned image (a standalone container is recreated with the image the backup recorded, keeping its settings)
# >>> export collector (the same text in export_run.sh, export_compose.sh, container_update.sh and backup_restore.sh; a test compares them)
# Docker's own `json` template function prints every string as JSON, so nothing a container contains can break the lines.
fmt='{{$c := .Config}}{{$h := .HostConfig}}ID {{json .Id}}
NAME {{json .Name}}
IMAGE {{json (index $c "Image")}}
IMGID {{.Image}}
{{range (index $c "Env")}}ENV {{json .}}
{{end}}CMDJ {{json (index $c "Cmd")}}
EPJ {{json (index $c "Entrypoint")}}
{{range (index $c "Cmd")}}CMD {{json .}}
{{end}}{{range (index $c "Entrypoint")}}EP {{json .}}
{{end}}{{range $k, $v := (index $c "Labels")}}LABEL {{json (printf "%s=%s" $k $v)}}
{{end}}{{range $p, $bs := (index $h "PortBindings")}}{{range $bs}}PORT {{json (index . "HostIp")}} {{json (index . "HostPort")}} {{json $p}}
{{end}}{{end}}{{range .Mounts}}MNT {{json .Type}} {{json (index . "Name")}} {{json .Source}} {{json .Destination}} {{.RW}}
{{end}}{{range $p, $o := (index $h "Tmpfs")}}TMPFS {{if $o}}{{json (printf "%s:%s" $p $o)}}{{else}}{{json $p}}{{end}}
{{end}}NETMODE {{json (index $h "NetworkMode")}}
{{range $n, $e := .NetworkSettings.Networks}}NETN {{json $n}}
{{range (index $e "Aliases")}}ALIAS {{json $n}} {{json .}}
{{end}}{{with (index $e "IPAMConfig")}}{{with (index . "IPv4Address")}}IP4 {{json $n}} {{json .}}
{{end}}{{with (index . "IPv6Address")}}IP6 {{json $n}} {{json .}}
{{end}}{{end}}{{end}}RP {{json (index (index $h "RestartPolicy") "Name")}}
RPN {{index (index $h "RestartPolicy") "MaximumRetryCount"}}
HOSTNAME {{json (index $c "Hostname")}}
USER {{json (index $c "User")}}
WORKDIR {{json (index $c "WorkingDir")}}
MEM {{index $h "Memory"}}
NANO {{index $h "NanoCpus"}}
{{range (index $h "Dns")}}DNS {{json .}}
{{end}}{{range (index $h "ExtraHosts")}}EXTRAHOST {{json .}}
{{end}}{{with (index $h "LogConfig")}}LOGT {{json (index . "Type")}}
{{range $k, $v := (index . "Config")}}LOGO {{json (printf "%s=%s" $k $v)}}
{{end}}{{end}}STOPSIG {{json (index $c "StopSignal")}}
STOPTO {{index $c "StopTimeout"}}
TTY {{index $c "Tty"}}
OPEN {{index $c "OpenStdin"}}
INIT {{index $h "Init"}}
RO {{index $h "ReadonlyRootfs"}}
HEALTHJ {{json (index $c "Healthcheck")}}
{{with (index $c "Healthcheck")}}{{range $i, $t := (index . "Test")}}{{if eq $i 0}}HKIND {{json $t}}
{{else}}HARG {{json $t}}
{{end}}{{end}}HINT {{index . "Interval"}}
HTO {{index . "Timeout"}}
HRET {{index . "Retries"}}
HSTART {{index . "StartPeriod"}}
{{end}}PRIV {{index $h "Privileged"}}
PIDM {{json (index $h "PidMode")}}
IPCM {{json (index $h "IpcMode")}}
{{range (index $h "CapAdd")}}CAPADD {{json .}}
{{end}}{{range (index $h "CapDrop")}}CAPDROP {{json .}}
{{end}}{{range (index $h "Devices")}}DEVICE {{json (printf "%s:%s:%s" .PathOnHost .PathInContainer .CgroupPermissions)}}
{{end}}{{range (index $h "SecurityOpt")}}SECOPT {{json .}}
{{end}}{{range $k, $v := (index $h "Sysctls")}}SYSCTL {{json (printf "%s=%s" $k $v)}}
{{end}}{{range (index $h "DeviceRequests")}}GPU {{index . "Count"}}
{{end}}{{range (index $h "DeviceCgroupRules")}}DCR {{json .}}
{{end}}{{range (index $h "Ulimits")}}ULIM {{json .Name}} {{.Soft}} {{.Hard}}
{{end}}{{range (index $h "GroupAdd")}}GRP {{json .}}
{{end}}{{range $k, $v := (index $h "StorageOpt")}}SOPT {{json (printf "%s=%s" $k $v)}}
{{end}}SHM {{index $h "ShmSize"}}
OOM {{index $h "OomScoreAdj"}}
CGP {{json (index $h "CgroupParent")}}
RT {{json (index $h "Runtime")}}
{{range (index $h "VolumesFrom")}}VFROM {{json .}}
{{end}}{{range (index $h "Links")}}LINK {{json .}}
{{end}}CPUSET {{json (index $h "CpusetCpus")}}
{{range (index $h "DnsSearch")}}DNSS {{json .}}
{{end}}{{range (index $h "DnsOptions")}}DNSO {{json .}}
{{end}}CPUSHARES {{index $h "CpuShares"}}
PIDSLIM {{index $h "PidsLimit"}}
MEMRES {{index $h "MemoryReservation"}}
UTS {{json (index $h "UTSMode")}}
USERNS {{json (index $h "UsernsMode")}}
'
ifmt='{{$c := .Config}}{{range (index $c "Env")}}ENV {{json .}}
{{end}}CMDJ {{json (index $c "Cmd")}}
EPJ {{json (index $c "Entrypoint")}}
{{range $k, $v := (index $c "Labels")}}LABEL {{json (printf "%s=%s" $k $v)}}
{{end}}{{range $k, $v := (index $c "Volumes")}}VOL {{json $k}}
{{end}}USER {{json (index $c "User")}}
WORKDIR {{json (index $c "WorkingDir")}}
STOPSIG {{json (index $c "StopSignal")}}
HEALTHJ {{json (index $c "Healthcheck")}}
'
# The container (C lines), its image's defaults (I lines) and the volumes and networks that exist (X lines) go into one input file.
collect() { # $1 = container, $2 = output file
  facts=$($D inspect --type container --format "$fmt" "$1" 2>/dev/null) || return 1
  imgid=$(printf '%s\n' "$facts" | sed -n 's/^IMGID //p' | head -n 1)
  { case "$imgid" in ''|*[!0-9a-zA-Z:]*) ;; *) $D image inspect --format "$ifmt" "$imgid" 2>/dev/null | sed 's/^/I /' ;; esac
    printf '%s\n' "$facts" | sed 's/^/C /'
    $D volume ls -q 2>/dev/null | sed 's/^/X vol /'
    $D network ls --format '{{.Name}}' 2>/dev/null | sed 's/^/X net /'
  } > "$2"
}
# <<< export collector
recreate_with_image() { # $1 = container, $2 = the image reference to run
  c=$1; ref=$2
  case "$ref" in ''|*[!A-Za-z0-9._/:@-]*) fail 'the pinned image reference is not valid' ;; esac
  cid=$($D inspect --type container --format '{{.Id}}' "$c" 2>/dev/null)
  case "$cid" in ''|*[!0-9a-f]*) fail "the container $c could not be read" ;; esac
  wasrun=$($D inspect --type container --format '{{.State.Running}}' "$c" 2>/dev/null)
  case "$wasrun" in true|false) ;; *) wasrun=true ;; esac
  collect "$c" "$tmp/in" || fail "the settings of $c could not be read"
  cat > "$tmp/prog.awk" <<'BOSUN_AWK_END'
# >>> export reader (the same text in export_run.sh, export_compose.sh, container_update.sh and backup_restore.sh; a test compares them)
# Input: lines "C TAG values" (the container), "I TAG values" (its image's own defaults), "X vol|net name" (what exists on the host).
# Values are JSON strings (Docker's own `json` template function) or plain numbers/booleans.
function hexval(h,   i, n, c) { n = 0; h = tolower(h); for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)); if (c == 0) return -1; n = n * 16 + c - 1 } return n }
function jset(s) { TS = s; TP = 1 }
function toknext(   c, o, k, n) {
  while (TP <= length(TS) && substr(TS, TP, 1) == " ") TP++
  if (TP > length(TS)) return ""
  c = substr(TS, TP, 1)
  if (c != "\"") { k = TP; while (TP <= length(TS) && substr(TS, TP, 1) != " ") TP++; o = substr(TS, k, TP - k); return (o == "null" ? "" : o) }
  TP++; o = ""
  while (TP <= length(TS)) {
    c = substr(TS, TP, 1)
    if (c == "\"") { TP++; return o }
    if (c == "\\") {
      TP++; c = substr(TS, TP, 1)
      if (c == "n") o = o "\n"; else if (c == "t") o = o "\t"; else if (c == "r") o = o "\r"; else if (c == "b") o = o "\b"; else if (c == "f") o = o "\f"
      else if (c == "u") { n = hexval(substr(TS, TP + 1, 4)); TP += 4; if (n > 0 && n < 128) o = o sprintf("%c", n); else if (n >= 128) o = o "?" }
      else o = o c
    } else o = o c
    TP++
  }
  return o
}
function isint(s) { return s ~ /^[0-9]+$/ && length(s) <= 18 }
function dur(n) { if (!isint(n) || n + 0 <= 0) return ""; if (n % 1000000000 == 0) return (n / 1000000000) "s"; if (n % 1000000 == 0) return (n / 1000000) "ms"; return n "ns" }
function capname(s) { sub(/^CAP_/, "", s); return s }
{
  src = substr($0, 1, 1); tag = $2; rest = $0; sub(/^[CIX] [A-Za-z0-9]+ ?/, "", rest)
  if (src == "X") { if (tag == "vol") vexists[rest] = 1; else if (tag == "net") nexists[rest] = 1; next }
  jset(rest)
  if (src == "I") {
    if (tag == "ENV") ienv[toknext()] = 1
    else if (tag == "LABEL") ilabel[toknext()] = 1
    else if (tag == "VOL") ivol[toknext()] = 1
    else if (tag == "CMDJ") icmdj = rest
    else if (tag == "EPJ") iepj = rest
    else if (tag == "USER") iuserj = rest
    else if (tag == "WORKDIR") iwdj = rest
    else if (tag == "STOPSIG") istopj = rest
    else if (tag == "HEALTHJ") ihealthj = rest
    next
  }
  if (tag == "ID") { id = toknext(); next }
  if (tag == "NAME") { cname = toknext(); next }
  if (tag == "IMAGE") { image = toknext(); next }
  if (tag == "IMGID") { imgid = rest; next }
  if (tag == "ENV") { v = toknext(); if (!(v in ienv)) env[++ne] = v; next }
  if (tag == "CMDJ") { cmdj = rest; next }
  if (tag == "EPJ") { epj = rest; next }
  if (tag == "CMD") { cmd[++ncmd] = toknext(); next }
  if (tag == "EP") { ep[++nep] = toknext(); next }
  if (tag == "LABEL") { v = toknext(); if (v ~ /^com\.docker\.compose\./) ncomp++; else if (!(v in ilabel)) lab[++nlab] = v; next }
  if (tag == "PORT") { np++; pip[np] = toknext(); php[np] = toknext(); pcp[np] = toknext(); next }
  if (tag == "MNT") { nm++; mtype[nm] = toknext(); mname[nm] = toknext(); msrc[nm] = toknext(); mdst[nm] = toknext(); mrw[nm] = toknext(); next }
  if (tag == "TMPFS") { tm[++ntm] = toknext(); next }
  if (tag == "NETMODE") { netmode = toknext(); next }
  if (tag == "NETN") { netn[++nnet] = toknext(); next }
  if (tag == "ALIAS") { nal++; alnet[nal] = toknext(); alname[nal] = toknext(); next }
  if (tag == "IP4") { k = toknext(); ip4[k] = toknext(); next }
  if (tag == "IP6") { k = toknext(); ip6[k] = toknext(); next }
  if (tag == "RP") { rp = toknext(); next }
  if (tag == "RPN") { rpn = rest; next }
  if (tag == "HOSTNAME") { host = toknext(); next }
  if (tag == "USER") { userj = rest; user = toknext(); next }
  if (tag == "WORKDIR") { wdj = rest; wd = toknext(); next }
  if (tag == "MEM") { mem = rest; next }
  if (tag == "NANO") { nano = rest; next }
  if (tag == "DNS") { dns[++ndns] = toknext(); next }
  if (tag == "EXTRAHOST") { xh[++nxh] = toknext(); next }
  if (tag == "LOGT") { logt = toknext(); next }
  if (tag == "LOGO") { lo[++nlo] = toknext(); next }
  if (tag == "STOPSIG") { stopj = rest; stopsig = toknext(); next }
  if (tag == "STOPTO") { stopto = rest; next }
  if (tag == "TTY") { tty = rest; next }
  if (tag == "OPEN") { open = rest; next }
  if (tag == "INIT") { init = rest; next }
  if (tag == "RO") { ro = rest; next }
  if (tag == "HEALTHJ") { healthj = rest; next }
  if (tag == "HKIND") { hkind = toknext(); next }
  if (tag == "HARG") { ha[++nha] = toknext(); next }
  if (tag == "HINT") { hint = rest; next }
  if (tag == "HTO") { hto = rest; next }
  if (tag == "HRET") { hret = rest; next }
  if (tag == "HSTART") { hstart = rest; next }
  if (tag == "PRIV") { priv = rest; next }
  if (tag == "PIDM") { pidm = toknext(); next }
  if (tag == "IPCM") { ipcm = toknext(); next }
  if (tag == "CAPADD") { cadd[++ncadd] = capname(toknext()); next }
  if (tag == "CAPDROP") { cdrop[++ncdrop] = capname(toknext()); next }
  if (tag == "DEVICE") { dev[++ndev] = toknext(); next }
  if (tag == "SECOPT") { sec[++nsec] = toknext(); next }
  if (tag == "SYSCTL") { sys[++nsys] = toknext(); next }
  if (tag == "GPU") { gpu = rest; next }
  if (tag == "DCR") { dcr[++ndcr] = toknext(); next }
  if (tag == "ULIM") { nul++; ulname[nul] = toknext(); ulsoft[nul] = toknext(); ulhard[nul] = toknext(); next }
  if (tag == "GRP") { grp[++ngrp] = toknext(); next }
  if (tag == "SOPT") { sop[++nsop] = toknext(); next }
  if (tag == "SHM") { shm = rest; next }
  if (tag == "OOM") { oom = rest; next }
  if (tag == "CGP") { cgp = toknext(); next }
  if (tag == "RT") { rt = toknext(); next }
  if (tag == "LINK") { links = links (links == "" ? "" : ", ") toknext(); next }
  if (tag == "VFROM") { vfrom = vfrom (vfrom == "" ? "" : ", ") toknext(); next }
  if (tag == "CPUSET") { cpuset = toknext(); next }
  if (tag == "DNSS") { dnss[++ndnss] = toknext(); next }
  if (tag == "DNSO") { dnso[++ndnso] = toknext(); next }
  if (tag == "CPUSHARES") { cpushares = rest; next }
  if (tag == "PIDSLIM") { pidslim = rest; next }
  if (tag == "MEMRES") { memres = rest; next }
  if (tag == "UTS") { uts = toknext(); next }
  if (tag == "USERNS") { userns = toknext(); next }
}
# The settings of the container as a person would give them (what differs from the image and from Docker's defaults).
function derive(   i, c) {
  sub(/^\//, "", cname)
  shortid = substr(id, 1, 12)
  if (netmode == "default" || netmode == "") netmode = "bridge"
  out_cmd = (cmdj != icmdj) ? 1 : 0
  out_ep = (epj != iepj) ? 1 : 0
  epclear = (out_ep && nep == 0) ? 1 : 0
  out_user = (userj != iuserj && user != "") ? user : ""
  out_wd = (wdj != iwdj && wd != "") ? wd : ""
  out_host = (host == shortid || netmode == "host" || host == "") ? "" : host
  out_stopsig = (stopj != istopj && stopsig != "") ? stopsig : ""
  out_stopto = isint(stopto) ? stopto : ""
  restart = ""
  if (rp == "always" || rp == "unless-stopped") restart = rp
  else if (rp == "on-failure") restart = (isint(rpn) && rpn + 0 > 0) ? "on-failure:" rpn : "on-failure"
  memory = ""
  if (isint(mem) && mem + 0 > 0) { if (mem % 1073741824 == 0) memory = (mem / 1073741824) "g"; else if (mem % 1048576 == 0) memory = (mem / 1048576) "m"; else memory = mem "b" }
  cpus = ""
  if (isint(nano) && nano + 0 > 0) { cpus = sprintf("%.9f", nano / 1000000000); sub(/0+$/, "", cpus); sub(/\.$/, "", cpus) }
  logdriver = logt; if (nlo == 0 && logdriver == "json-file") logdriver = ""
  hnone = 0; hcmd = ""; out_health = 0
  if (healthj != ihealthj && healthj != "null" && hkind != "") {
    out_health = 1
    if (hkind == "NONE") hnone = 1
    else if (hkind == "CMD-SHELL") hcmd = ha[1]
    else if (hkind == "CMD") { for (i = 1; i <= nha; i++) hcmd = hcmd (i > 1 ? " " : "") shq(ha[i]) }
    hint_o = dur(hint); hto_o = dur(hto); hstart_o = dur(hstart)
    hret_o = (isint(hret) && hret + 0 > 0) ? hret : ""
  }
  gpus = ""; if (gpu == "-1") gpus = "all"; else if (isint(gpu) && gpu + 0 > 0) gpus = gpu
  for (i = 1; i <= nm; i++) {
    c = 0
    if (mtype[i] == "volume" && length(mname[i]) == 64 && mname[i] ~ /^[0-9a-f]+$/) c = 1
    manon[i] = c
    mskip[i] = (c && (mdst[i] in ivol)) ? 1 : 0
  }
  unm = ""
  if (links != "") unm = unm (unm == "" ? "" : "; ") "links (" links ")"
  if (vfrom != "") unm = unm (unm == "" ? "" : "; ") "volumes-from (" vfrom ")"
  if (ncomp > 0) unm = unm (unm == "" ? "" : "; ") "the compose labels com.docker.compose.*"
}
function shq(s,   o, i, c, n) {
  if (s == "") return "''"
  if (s ~ /^[A-Za-z0-9_@%+=:,.\/-]+$/) return s
  o = "'"; n = length(s)
  for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "'") o = o "'\\''"; else o = o c }
  return o "'"
}
function pubport(i,   p, h) {
  p = pcp[i]; sub(/\/tcp$/, "", p)
  h = pip[i]; if (h ~ /:/) h = "[" h "]"
  if (pip[i] != "") return h ":" php[i] ":" p
  if (php[i] != "") return php[i] ":" p
  return p
}
# <<< export reader
# >>> export run writer (the same text in export_run.sh, container_update.sh and backup_restore.sh; a test compares them)
function add(s) { L[++nl] = s }
function opt(flag, v) { add(flag " " shq(v)) }
END {
  derive()
  if (nameoverride != "") { if (nameeq != "") add("--name=" shq(nameoverride)); else add("--name " shq(nameoverride)) }
  else if (nameeq != "") add("--name=" shq(cname)); else add("--name " shq(cname))
  if (restart != "") opt("--restart", restart)
  if (out_host != "") opt("--hostname", out_host)
  if (out_user != "") opt("--user", out_user)
  if (out_wd != "") opt("--workdir", out_wd)
  if (netmode != "bridge") opt("--network", netmode)
  if (netmode != "bridge" && netmode != "host" && netmode != "none" && netmode !~ /^container:/) {
    for (i = 1; i <= nal; i++) if (alnet[i] == netmode && alname[i] != shortid && alname[i] != cname) opt("--network-alias", alname[i])
    if (netmode in ip4) opt("--ip", ip4[netmode])
    if (netmode in ip6) opt("--ip6", ip6[netmode])
  }
  for (i = 1; i <= np; i++) opt("-p", pubport(i))
  for (i = 1; i <= nm; i++) {
    if (mtype[i] != "bind" && mtype[i] != "volume") continue
    if (mskip[i] && keepvols == "") continue
    if (manon[i] && keepvols == "") { opt("-v", mdst[i]); continue }
    if (mtype[i] == "bind") v = msrc[i] ":" mdst[i]
    else if (mname[i] == "") { opt("-v", mdst[i]); continue }
    else v = mname[i] ":" mdst[i]
    if (mrw[i] == "false") v = v ":ro"
    opt("-v", v)
  }
  for (i = 1; i <= ntm; i++) opt("--tmpfs", tm[i])
  for (i = 1; i <= ne; i++) opt("-e", env[i])
  for (i = 1; i <= nlab; i++) opt("--label", lab[i])
  if (memory != "") opt("--memory", memory)
  if (cpus != "") opt("--cpus", cpus)
  if (isint(memres) && memres + 0 > 0) opt("--memory-reservation", memres)
  if (isint(cpushares) && cpushares + 0 > 0) opt("--cpu-shares", cpushares)
  if (isint(pidslim) && pidslim + 0 > 0) opt("--pids-limit", pidslim)
  if (cpuset != "") opt("--cpuset-cpus", cpuset)
  if (isint(shm) && shm + 0 > 0 && shm + 0 != 67108864) opt("--shm-size", shm)
  if (oom != "" && oom != "0" && oom ~ /^-?[0-9]+$/) opt("--oom-score-adj", oom)
  for (i = 1; i <= nul; i++) opt("--ulimit", ulname[i] "=" ulsoft[i] ":" ulhard[i])
  for (i = 1; i <= ngrp; i++) opt("--group-add", grp[i])
  for (i = 1; i <= ndns; i++) opt("--dns", dns[i])
  for (i = 1; i <= ndnss; i++) opt("--dns-search", dnss[i])
  for (i = 1; i <= ndnso; i++) opt("--dns-option", dnso[i])
  for (i = 1; i <= nxh; i++) opt("--add-host", xh[i])
  if (logdriver != "") opt("--log-driver", logdriver)
  for (i = 1; i <= nlo; i++) opt("--log-opt", lo[i])
  if (out_stopsig != "") opt("--stop-signal", out_stopsig)
  if (out_stopto != "") opt("--stop-timeout", out_stopto)
  if (tty == "true") add("-t")
  if (open == "true") add("-i")
  if (init == "true") add("--init")
  if (ro == "true") add("--read-only")
  if (out_health) {
    if (hnone) add("--no-healthcheck")
    else {
      if (hcmd != "") opt("--health-cmd", hcmd)
      if (hint_o != "") opt("--health-interval", hint_o)
      if (hto_o != "") opt("--health-timeout", hto_o)
      if (hret_o != "") opt("--health-retries", hret_o)
      if (hstart_o != "") opt("--health-start-period", hstart_o)
    }
  }
  if (priv == "true") add("--privileged")
  if (pidm == "host") add("--pid host")
  if (ipcm == "host") add("--ipc host")
  if (uts == "host") add("--uts host")
  if (userns == "host") add("--userns host")
  for (i = 1; i <= ncadd; i++) opt("--cap-add", cadd[i])
  for (i = 1; i <= ncdrop; i++) opt("--cap-drop", cdrop[i])
  for (i = 1; i <= ndev; i++) opt("--device", dev[i])
  for (i = 1; i <= nsec; i++) opt("--security-opt", sec[i])
  for (i = 1; i <= nsys; i++) opt("--sysctl", sys[i])
  if (gpus != "") opt("--gpus", gpus)
  for (i = 1; i <= ndcr; i++) opt("--device-cgroup-rule", dcr[i])
  if (cgp != "") opt("--cgroup-parent", cgp)
  if (rt != "" && rt != "runc") opt("--runtime", rt)
  for (i = 1; i <= nsop; i++) opt("--storage-opt", sop[i])
  if (out_ep) { if (epclear) opt("--entrypoint", ""); else opt("--entrypoint", ep[1]) }
  s = "docker run -d"
  for (i = 1; i <= nl; i++) s = s " \\\n  " L[i]
  s = s " \\\n  " shq(newimage != "" ? newimage : image)
  args = ""
  if (out_ep) for (i = 2; i <= nep; i++) args = args " " shq(ep[i])
  if (out_cmd) for (i = 1; i <= ncmd; i++) args = args " " shq(cmd[i])
  if (args != "") s = s " \\\n " args
  print s
  # what no docker run flag carries here
  if (unm != "") print "# Not exported: " unm
  extra = ""
  for (i = 1; i <= nnet; i++) if (netn[i] != netmode && netn[i] != "bridge" && !(netmode == "bridge" && netn[i] == "bridge")) extra = extra (extra == "" ? "" : ", ") netn[i]
  if (extra != "") print "# Also attached to the networks: " extra " (docker network connect <network> " cname ")"
}
# <<< export run writer
BOSUN_AWK_END
  if ! awk -v newimage="$ref" -v nameoverride="$c" -v nameeq=1 -v keepvols=1 -f "$tmp/prog.awk" "$tmp/in" > "$tmp/out" 2>"$tmp/err"; then
    fail "the settings of $c could not be read for the pinned image: $(lastline "$tmp/err")"
  fi
  cmd=$(cat "$tmp/out")
  case "$cmd" in 'docker run -d'*) ;; *) fail 'could not build the container command' ;; esac
  rest=${cmd#docker run -d}
  if ! $D image inspect "$ref" >/dev/null 2>&1; then
    echo "[step] Pulling $ref"
    $D pull "$ref" >/dev/null 2>&1 || fail "the image $ref could not be pulled (the data was restored)"
  fi
  old="$c-bosun-old"
  if $D inspect --type container --format '{{.Id}}' "$old" >/dev/null 2>&1; then fail "a container named $old exists (left over from an earlier restore); remove it first"; fi
  echo "[step] Recreating $c with $ref"
  NEWID=''
  rollback() {
    [ -z "$NEWID" ] || $D rm -f "$NEWID" >/dev/null 2>&1
    if ! $D rename "$old" "$c" >/dev/null 2>&1; then fail "$1; and the old container could not be renamed back (it is still $old)"; fi
    if [ "$wasrun" = true ]; then $D start "$c" >/dev/null 2>&1; fi
    fail "$1 (the old container $c was put back)"
  }
  $D rename "$c" "$old" >/dev/null 2>"$tmp/err" || fail "the container $c could not be renamed: $(lastline "$tmp/err")"
  NEWID=$(sh -c "$D create$rest" 2>"$tmp/err") || { NEWID=''; rollback "creating the container failed: $(lastline "$tmp/err")"; }
  NEWID=$(printf '%s\n' "$NEWID" | tail -n 1)
  case "$NEWID" in ''|*[!0-9a-f]*) NEWID=''; rollback 'docker create gave an unexpected answer' ;; esac
  if [ "$wasrun" = true ]; then
    $D stop "$old" >/dev/null 2>&1
    $D start "$NEWID" >/dev/null 2>"$tmp/err" || rollback "the new container could not be started: $(lastline "$tmp/err")"
    wait=${BOSUN_RECREATE_WAIT:-2}; case "$wait" in ''|*[!0-9]*) wait=2 ;; esac
    [ "$wait" -eq 0 ] || sleep "$wait"
    st=$($D inspect --type container --format '{{.State.Running}}' "$NEWID" 2>/dev/null)
    [ "$st" = true ] || rollback 'the new container did not stay running'
  fi
  $D rm -f "$old" >/dev/null 2>&1
  echo "[step] $c now runs $ref"
}
pin_stack() { # $1 = stack name; redeploys it with an extra override file, the user's compose file is left alone
  s=$1
  DIR="$HOME/bosun-stacks/$s"
  [ -d "$DIR" ] || fail "the data was restored, but the stack $s was not created by Bosun, so its image cannot be pinned"
  meta_get() { [ -f "$DIR/bosun.meta" ] || return 0; while IFS= read -r l; do case "$l" in "$1="*) printf '%s' "${l#*=}"; return 0 ;; esac; done < "$DIR/bosun.meta"; }
  if [ "$(meta_get source)" = git ]; then
    f=$(meta_get file)
    case "$f" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail "the stored stack record of $s is damaged" ;; esac
    cf="$DIR/repo/$f"
    if [ -L "$cf" ] || [ ! -f "$cf" ]; then fail "the data was restored, but the compose file of $s is missing or a link out of the checkout"; fi
  else cf="$DIR/compose.yaml"; fi
  [ -f "$cf" ] || fail "the data was restored, but the compose file of $s is missing"
  pd=$(dirname "$cf")
  { printf 'services:\n'; found=0
    while IFS='	' read -r c svc ref ver; do
      [ -n "$svc" ] && [ "$svc" != - ] || continue
      case "$svc" in *[!A-Za-z0-9_.-]*) fail 'the pinned service name is not valid' ;; esac
      case "$ref" in ''|*[!A-Za-z0-9._/:@-]*) fail 'the pinned image reference is not valid' ;; esac
      printf '  %s:\n    image: "%s"\n' "$svc" "$ref"; found=1
    done < "$tmp/pinned"
    [ "$found" -eq 1 ] || fail 'the backup recorded no image version for this stack'
  } > "$tmp/pin.yaml" || fail 'the pin override could not be written'
  pinf="$DIR/compose.backup-pin.yaml"
  [ ! -f "$pinf" ] || cp "$pinf" "$pinf.bak-$(now_stamp)" 2>/dev/null
  cp "$tmp/pin.yaml" "$pinf" || fail 'the pin override could not be written'
  set -- compose -p "$s" --project-directory "$pd" -f "$cf"
  [ ! -f "$DIR/compose.override.yaml" ] || set -- "$@" -f "$DIR/compose.override.yaml"
  set -- "$@" -f "$pinf"
  [ ! -f "$DIR/.env" ] || set -- "$@" --env-file "$DIR/.env"
  set -- "$@" up -d --remove-orphans
  if ! $D "$@" >/dev/null 2>"$tmp/err"; then
    set -- compose -p "$s" --project-directory "$pd" -f "$cf"
    [ ! -f "$DIR/compose.override.yaml" ] || set -- "$@" -f "$DIR/compose.override.yaml"
    [ ! -f "$DIR/.env" ] || set -- "$@" --env-file "$DIR/.env"
    set -- "$@" up -d --remove-orphans
    $D "$@" >/dev/null 2>&1
    fail "the data was restored, but the stack could not be redeployed on the pinned image: $(lastline "$tmp/err")"
  fi
  echo "[step] $s now runs the images from the backup (see $pinf; delete it and redeploy to undo)"
}
# <<< pinned image
STOPPED=''
start_stopped() {
  [ -z "$STOPPED" ] && return 0
  for c in $STOPPED; do $D start "$c" >/dev/null 2>&1; done
  STOPPED=''
}
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'start_stopped; rm -rf "$tmp"; restic_cleanup' EXIT

# ---- list ----------------------------------------------------------------------------------------------------
if [ "$mode" = list ]; then
  configured=false; initialised=false; state='Not configured'; message='Set the backup destination and password in Settings -> Widgets -> Docker -> Secrets, then initialise the repository.'
  size_bytes=0; snapshots=0; rows='[]'; errf="$tmp/err"; : > "$errf"
  if restic_configured; then
    configured=true; state='Not initialised'; message='The repository is not initialised yet: open Backups and run Initialise repository.'
    if restic_prepare >/dev/null 2>"$errf"; then
      if restic_run -r "$RESTIC_REPO_ARG" cat config >/dev/null 2>"$errf"; then
        initialised=true; state='Ready'; message=''
        jsn=$(restic_run -r "$RESTIC_REPO_ARG" snapshots --json 2>"$errf")
        if [ -n "$jsn" ]; then
          snapshots=$(printf '%s' "$jsn" | grep -o '"short_id"' | wc -l | tr -d ' ')
          rows=$(printf '%s' "$jsn" | awk -v kindfilter="$kind" '
            function esc(s,   o, n, k, c) { o = ""; n = length(s); for (k = 1; k <= n; k++) { c = substr(s, k, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c } return o }
            function field(s, nm,   re, x) { re = "\"" nm "\"[ \t]*:[ \t]*\"([^\"]*)\""; if (!match(s, re)) return ""; x = substr(s, RSTART, RLENGTH); sub(/^[^:]*:[ \t]*"/, "", x); sub(/"$/, "", x); return x }
            function taglist(s,   x) { if (!match(s, /"tags"[ \t]*:[ \t]*\[[^]]*\]/)) return ""; x = substr(s, RSTART, RLENGTH); sub(/^[^[]*\[/, "", x); sub(/\].*$/, "", x); gsub(/"/, "", x); gsub(/,/, " ", x); return x }
            function human(b,   i, u) { split("B KiB MiB GiB TiB PiB", u, " "); i = 1; while (b >= 1024 && i < 6) { b /= 1024; i++ } return (i == 1) ? sprintf("%d %s", b, u[i]) : sprintf("%.1f %s", b, u[i]) }
            function process(o,   id, sid, time, host, tl, n, a, i, t, kd, cname, sname, inc, pin, ver, by, nm, cf, sf, bb, sz) {
              id = field(o, "id"); if (id == "") return
              sid = field(o, "short_id"); time = field(o, "time"); host = field(o, "hostname"); tl = taglist(o)
              if (tl !~ /bosun:/) return
              n = split(tl, a, " "); kd = ""; cname = ""; sname = ""; inc = ""; pin = ""; ver = ""; by = ""
              for (i = 1; i <= n; i++) {
                t = a[i]; if (t == "") continue
                if (index(t, "bosun:kind=") == 1) kd = substr(t, 12)
                else if (index(t, "bosun:container=") == 1) cname = substr(t, 17)
                else if (index(t, "bosun:stack=") == 1) sname = substr(t, 13)
                else if (t == "bosun:volumes=1") inc = inc (inc == "" ? "" : ", ") "volumes"
                else if (t == "bosun:binds=1") inc = inc (inc == "" ? "" : ", ") "mapped folders"
                else if (t == "bosun:files=1") inc = inc (inc == "" ? "" : ", ") "stack files"
                else if (t == "bosun:image=1") inc = inc (inc == "" ? "" : ", ") "image"
                else if (index(t, "bosun:pinned=") == 1) pin = pin (pin == "" ? "" : ", ") substr(t, 14)
                else if (index(t, "bosun:version=") == 1) ver = ver (ver == "" ? "" : ", ") substr(t, 15)
                else if (index(t, "bosun:bytes=") == 1) by = substr(t, 13)
              }
              if (kindfilter != "all" && kd != kindfilter) return
              nm = (kd == "stack") ? sname : cname
              if (nm == "") return
              cf = (kd == "stack") ? ("stack:" nm) : cname
              sf = (kd == "stack") ? nm : sname
              bb = (by ~ /^[0-9]+$/) ? by + 0 : 0
              sz = (bb > 0) ? human(bb) : ""
              nrows++
              rows[nrows] = sprintf("{\"id\":\"%s\",\"short\":\"%s\",\"time\":\"%s\",\"kind\":\"%s\",\"name\":\"%s\",\"container\":\"%s\",\"stack\":\"%s\",\"size_bytes\":%d,\"size\":\"%s\",\"included\":\"%s\",\"pinned_ref\":\"%s\",\"pinned_version\":\"%s\",\"hostname\":\"%s\"}", esc(id), esc(sid), esc(time), esc(kd), esc(nm), esc(cf), esc(sf), bb, esc(sz), esc(inc), esc(pin), esc(ver), esc(host))
            }
            { buf = buf $0 "\n" }
            END {
              s = buf; n = length(s); d = 0; o = ""
              for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "{") { d++; if (d == 1) { o = "{"; continue } } if (d >= 1) o = o c; if (c == "}") { d--; if (d == 0) { process(o); o = "" } } }
              printf "["
              for (i = nrows; i >= 1; i--) printf "%s%s", (i == nrows ? "" : ","), rows[i]
              print "]"
            }')
        fi
        st=$(restic_run -r "$RESTIC_REPO_ARG" stats --mode raw-data --json 2>/dev/null)
        size_bytes=$(printf '%s' "$st" | sed -n 's/.*"total_size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
        case "$size_bytes" in ''|*[!0-9]*) size_bytes=0 ;; esac
      else
        state='Unavailable'
        msg=$(lastline "$errf")
        message=${msg:-'the backup repository could not be reached'}
      fi
    else
      state='Unavailable'
      msg=$(lastline "$errf")
      message=${msg:-'the backup destination is not valid'}
    fi
  fi
  size=''; [ "$size_bytes" -le 0 ] || size=$(human_bytes "$size_bytes")
  case "$rows" in \[*\]) ;; *) rows='[]' ;; esac
  printf '{"status":{"configured":%s,"initialised":%s,"repository":%s,"snapshots":%d,"size":%s,"size_bytes":%d,"state":%s,"message":%s},"rows":%s}\n' \
    "$configured" "$initialised" "$(jstr "$BACKUP_REPOSITORY")" "$snapshots" "$(jstr "$size")" "$size_bytes" "$(jstr "$state")" "$(jstr "$message")" "$rows"
  exit 0
fi

# ---- restore and forget --------------------------------------------------------------------------------------
restic_prepare
errf="$tmp/err"; : > "$errf"
if [ "$mode" = forget ]; then
  echo 'PROGRESS 0/1'
  echo "[step] Deleting the snapshot $snapshot"
  if ! restic_run -r "$RESTIC_REPO_ARG" forget "$snapshot" --prune >/dev/null 2>"$errf"; then
    fail "deleting the snapshot failed: $(lastline "$errf")"
  fi
  echo 'PROGRESS 1/1'
  echo "DONE deleted the backup $snapshot"
  exit 0
fi
echo 'PROGRESS 0/5'
echo "[step] Reading the backup $snapshot"
if ! restic_run -r "$RESTIC_REPO_ARG" dump "$snapshot" /bosun/meta/restore_map > "$tmp/map" 2>"$errf"; then
  fail "the backup has no restore information: $(lastline "$errf")"
fi
if ! restic_run -r "$RESTIC_REPO_ARG" dump "$snapshot" /bosun/meta/pinned_map > "$tmp/pinned" 2>/dev/null; then : > "$tmp/pinned"; fi
# What the snapshot recorded: container, type, source, destination, read-write, the path inside the snapshot.
: > "$tmp/plan"
n=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  f1=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $1 }')
  [ -n "$f1" ] || fail 'the restore information of this backup is damaged'
  if [ "$kind" = container ] && [ "$f1" != "$name" ]; then continue; fi
  mt=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $2 }')
  src=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $3 }')
  dst=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $4 }')
  rw=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $5 }')
  tgt=$(printf '%s' "$line" | awk -F '\t' 'NF == 6 { print $6 }')
  case "$mt" in volume|bind) ;; *) fail 'the restore information of this backup is damaged' ;; esac
  case "$dst" in /*) ;; *) fail 'the restore information of this backup is damaged' ;; esac
  case "$dst" in *..*) fail 'the restore information of this backup is damaged' ;; esac
  case "$tgt" in /bosun/data/*) ;; *) fail 'the restore information of this backup is damaged' ;; esac
  case "$tgt" in *..*) fail 'the restore information of this backup is damaged' ;; esac
  if [ "$mt" = bind ]; then
    case "$src" in /*) ;; *) fail 'the restore information of this backup is damaged' ;; esac
    if host_path_sensitive "$src"; then fail "the backup would write to the sensitive host path $src"; fi
  fi
  n=$((n + 1))
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f1" "$mt" "$src" "$dst" "$rw" "$tgt" >> "$tmp/plan"
done < "$tmp/map"
[ "$n" -gt 0 ] || fail "this backup has no data for $name"
# The containers to stop (only the ones that exist and run).
if [ "$restore_mode" = replace ]; then
  CN=''
  for c in $(cut -f 1 "$tmp/plan" | sort -u); do
    case "$CN" in *" $c "*) continue ;; esac
    CN="$CN $c "
    id=$($D inspect --type container --format '{{.Id}}' "$c" 2>/dev/null) || continue
    run=$($D inspect --type container --format '{{.State.Running}}' "$c" 2>/dev/null)
    if [ "$run" = true ]; then
      echo "[step] Stopping $c"
      $D stop "$id" >/dev/null 2>&1 || fail "the container $c could not be stopped"
      STOPPED="$STOPPED $id"
    fi
  done
fi
echo 'PROGRESS 1/5'
echo '[step] Preparing the target volumes'
stamp=$(now_stamp); i=0; where=''
while IFS='	' read -r c mt src dst rw tgt; do
  i=$((i + 1))
  if [ "$restore_mode" = new_volume ]; then
    if [ "$mt" = volume ]; then src="bosun-restore-$stamp-$i"; $D volume create "$src" >/dev/null 2>&1 || fail "the volume $src could not be created"
    else src="$HOME/bosun-restores/$stamp/$i"; mkdir -p "$src" 2>/dev/null || fail "the folder $src could not be created"; fi
    where="$where$c $mt -> $src
"
  else
    if [ "$mt" = volume ]; then
      $D volume inspect "$src" >/dev/null 2>&1 || $D volume create "$src" >/dev/null 2>&1 || fail "the volume $src could not be created"
    else mkdir -p "$src" 2>/dev/null || fail "the folder $src could not be created"; fi
  fi
  restic_add_docker -v; restic_add_docker "$src:/bosun/target-root$tgt"
done < "$tmp/plan"
echo 'PROGRESS 2/5'
echo '[step] Restoring the data'
if ! restic_shell 'R=$(command -v restic 2>/dev/null || echo /bin/restic); "$R" restore "$1" --target /bosun/target-root --delete --include /bosun/data' "$snapshot" > "$tmp/restore.out" 2>"$errf"; then
  fail "the data could not be restored: $(lastline "$errf")"
fi
echo 'PROGRESS 3/5'
start_stopped
if [ "$restore_mode" = new_volume ]; then
  echo 'PROGRESS 5/5'
  printf 'DONE restored the backup into new volumes and folders (nothing running was changed): %s\n' "$where"
  exit 0
fi
if [ "$pin_image" = true ]; then
  echo '[step] Pinning the image to the version in the backup'
  if [ "$kind" = container ]; then
    ref=$(awk -F '\t' -v c="$name" '$1 == c { print $3; exit }' "$tmp/pinned")
    if [ -n "$ref" ]; then
      recreate_with_image "$name" "$ref"
    else
      echo "[step] The backup recorded no image version for $name; the container keeps its image"
    fi
  else
    if [ -s "$tmp/pinned" ]; then
      pin_stack "$name"
    else
      echo "[step] The backup recorded no image version for the stack $name; it keeps its images"
    fi
  fi
fi
start_stopped
echo 'PROGRESS 5/5'
echo "DONE restored the backup $snapshot into $name"
exit 0
