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
clone_fmt='{{$c := .Config}}{{$h := .HostConfig}}
ID	{{.Id}}
RUN	{{.State.Running}}
REF	{{$c.Image}}
IMGID	{{.Image}}
HOSTNAME	{{$c.Hostname}}
USER	{{$c.User}}
WORKDIR	{{$c.WorkingDir}}
TTY	{{$c.Tty}}
OPEN	{{$c.OpenStdin}}
STOPSIG	{{$c.StopSignal}}
STOPTO	{{$c.StopTimeout}}
NETMODE	{{$h.NetworkMode}}
RESTART	{{$h.RestartPolicy.Name}}
RETRY	{{$h.RestartPolicy.MaximumRetryCount}}
MEM	{{$h.Memory}}
MEMRES	{{$h.MemoryReservation}}
NANO	{{$h.NanoCpus}}
CPUSHARES	{{$h.CpuShares}}
CPUSET	{{$h.CpusetCpus}}
PIDSLIM	{{$h.PidsLimit}}
PRIV	{{$h.Privileged}}
PIDM	{{$h.PidMode}}
IPCM	{{$h.IpcMode}}
UTS	{{$h.UTSMode}}
USERNS	{{$h.UsernsMode}}
CGP	{{$h.CgroupParent}}
RT	{{$h.Runtime}}
SHM	{{$h.ShmSize}}
OOM	{{$h.OomScoreAdj}}
INIT	{{$h.Init}}
RO	{{$h.ReadonlyRootfs}}
LOGT	{{$h.LogConfig.Type}}
{{range $c.Env}}ENV	{{.}}
{{end}}{{range $k, $v := $c.Labels}}LABEL	{{$k}}={{$v}}
{{end}}{{range $c.Cmd}}CMD	{{.}}
{{end}}{{range $c.Entrypoint}}EP	{{.}}
{{end}}{{range .Mounts}}MNT	{{.Type}}	{{.Name}}	{{.Source}}	{{.Destination}}	{{.RW}}
{{end}}{{range $p, $bs := $h.PortBindings}}{{range $bs}}PORT	{{.HostIp}}	{{.HostPort}}	{{$p}}
{{end}}{{end}}{{range $n, $e := .NetworkSettings.Networks}}NET	{{$n}}
{{range $e.Aliases}}ALIAS	{{$n}}	{{.}}
{{end}}{{with $e.IPAMConfig}}{{with .IPv4Address}}IP4	{{$n}}	{{.}}
{{end}}{{with .IPv6Address}}IP6	{{$n}}	{{.}}
{{end}}{{end}}{{end}}{{range $h.Dns}}DNS	{{.}}
{{end}}{{range $h.DnsSearch}}DNSS	{{.}}
{{end}}{{range $h.DnsOptions}}DNSO	{{.}}
{{end}}{{range $h.ExtraHosts}}EXTRAHOST	{{.}}
{{end}}{{range $k, $v := $h.LogConfig.Config}}LOGO	{{$k}}={{$v}}
{{end}}{{range $p, $o := $h.Tmpfs}}TMPFS	{{$p}}:{{$o}}
{{end}}{{range $h.CapAdd}}CAPADD	{{.}}
{{end}}{{range $h.CapDrop}}CAPDROP	{{.}}
{{end}}{{range $h.SecurityOpt}}SECOPT	{{.}}
{{end}}{{range $k, $v := $h.Sysctls}}SYSCTL	{{$k}}={{$v}}
{{end}}{{range $h.Devices}}DEVICE	{{.PathOnHost}}	{{.PathInContainer}}	{{.CgroupPermissions}}
{{end}}{{range $h.Ulimits}}ULIMIT	{{.Name}}	{{.Soft}}	{{.Hard}}
{{end}}{{range $h.GroupAdd}}GRP	{{.}}
{{end}}{{range $h.DeviceCgroupRules}}DCR	{{.}}
{{end}}{{range $h.DeviceRequests}}GPU	{{.Count}}
{{end}}{{range $k, $v := $h.StorageOpt}}SOPT	{{$k}}={{$v}}
{{end}}{{with $c.Healthcheck}}HK	{{json .Test}}
HKINT	{{.Interval}}
HKTMO	{{.Timeout}}
HKRET	{{.Retries}}
HKSTART	{{.StartPeriod}}
{{end}}'
recreate_with_image() { # $1 = container, $2 = the image reference to run
  c=$1; ref=$2
  case "$ref" in ''|*[!A-Za-z0-9._/:@-]*) fail 'the pinned image reference is not valid' ;; esac
  : > "$tmp/facts"; : > "$tmp/clone.cmd"
  if ! $D inspect --type container --format "$clone_fmt" "$c" > "$tmp/clone.raw" 2>"$tmp/err"; then
    fail "the settings of $c could not be read: $(lastline "$tmp/err")"
  fi
  awk -F '\t' -v facts="$tmp/facts" -v cmdf="$tmp/clone.cmd" '
    function unq(s) { gsub(/^"|"$/, "", s); gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s); return s }
    function hk(j,   s, typ, rest, out) {
      s = j; sub(/^\[/, "", s); sub(/\]$/, "", s)
      if (match(s, /^"[^"]*"/)) { typ = unq(substr(s, RSTART, RLENGTH)); s = substr(s, RLENGTH + 1); sub(/^,/, "", s) }
      if (typ == "NONE" || typ == "") return ""
      if (typ == "CMD-SHELL") return unq(s)
      out = ""; rest = s
      while (match(rest, /"[^"]*"/)) { out = out (out == "" ? "" : " ") unq(substr(rest, RSTART, RLENGTH)); rest = substr(rest, RSTART + RLENGTH) }
      return out
    }
    function dur(n) { if (n % 1000000000 == 0) return (n / 1000000000) "s"; if (n % 1000000 == 0) return (n / 1000000) "ms"; return n "ns" }
    function isint(s) { return s ~ /^[0-9]+$/ }
    BEGIN { bad = 0; epn = 0; nets = 0; netmode = ""; restart = ""; retry = ""; hkcmd = ""; hkint = 0; hktmo = 0; hkret = 0; hkstart = 0 }
    NF == 0 { next }
    $1 == "ID" { if (NF != 2) bad = 1; else print "id=" $2 > facts; next }
    $1 == "RUN" { if (NF != 2) bad = 1; else print "run=" $2 > facts; next }
    $1 == "REF" { if (NF != 2) bad = 1; else print "ref=" $2 > facts; next }
    $1 == "IMGID" { if (NF != 2) bad = 1; else print "imgid=" $2 > facts; next }
    $1 == "ENV" { if (NF != 2) bad = 1; else print "--env=" $2; next }
    $1 == "LABEL" { if (NF != 2) bad = 1; else print "--label=" $2; next }
    $1 == "CMD" { if (NF != 2) bad = 1; else print $2 > cmdf; next }
    $1 == "EP" { if (NF != 2) bad = 1; else if (epn == 0) { epn = 1; print "--entrypoint=" $2 } else print $2 > cmdf; next }
    $1 == "MNT" {
      if (NF != 6) { bad = 1; next }
      if ($2 == "volume") { if ($3 == "" || $5 == "") { bad = 1; next } print "--volume=" $3 ":" $5 ($6 == "true" ? "" : ":ro") }
      else if ($2 == "bind") { if ($4 == "" || $5 == "") { bad = 1; next } print "--volume=" $4 ":" $5 ($6 == "true" ? "" : ":ro") }
      next
    }
    $1 == "PORT" {
      if (NF != 4) { bad = 1; next }
      if ($2 != "") print "--publish=" $2 ":" ($3 == "" ? "" : $3) ":" $4
      else if ($3 != "") print "--publish=" $3 ":" $4
      else print "--publish=" $4
      next
    }
    $1 == "NET" { if (NF != 2) { bad = 1; next } nets++; print "--network=" $2; next }
    $1 == "ALIAS" { if (NF != 3) { bad = 1; next } print "--network-alias=" $3; next }
    $1 == "IP4" { if (NF != 3) { bad = 1; next } print "--ip=" $3; next }
    $1 == "IP6" { if (NF != 3) { bad = 1; next } print "--ip6=" $3; next }
    $1 == "DNS" { if (NF != 2) { bad = 1; next } print "--dns=" $2; next }
    $1 == "DNSS" { if (NF != 2) { bad = 1; next } print "--dns-search=" $2; next }
    $1 == "DNSO" { if (NF != 2) { bad = 1; next } print "--dns-option=" $2; next }
    $1 == "EXTRAHOST" { if (NF != 2) { bad = 1; next } print "--add-host=" $2; next }
    $1 == "LOGT" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--log-driver=" $2; next }
    $1 == "LOGO" { if (NF != 2) { bad = 1; next } print "--log-opt=" $2; next }
    $1 == "TMPFS" { if (NF != 2) { bad = 1; next } print "--tmpfs=" $2; next }
    $1 == "CAPADD" { if (NF != 2) { bad = 1; next } print "--cap-add=" $2; next }
    $1 == "CAPDROP" { if (NF != 2) { bad = 1; next } print "--cap-drop=" $2; next }
    $1 == "SECOPT" { if (NF != 2) { bad = 1; next } print "--security-opt=" $2; next }
    $1 == "SYSCTL" { if (NF != 2) { bad = 1; next } print "--sysctl=" $2; next }
    $1 == "DEVICE" { if (NF != 4) { bad = 1; next } print "--device=" $2 ":" $3 ":" $4; next }
    $1 == "ULIMIT" { if (NF != 4) { bad = 1; next } print "--ulimit=" $2 "=" $3 ":" $4; next }
    $1 == "GRP" { if (NF != 2) { bad = 1; next } print "--group-add=" $2; next }
    $1 == "DCR" { if (NF != 2) { bad = 1; next } print "--device-cgroup-rule=" $2; next }
    $1 == "GPU" { if (NF != 2) { bad = 1; next } if ($2 == "-1") print "--gpus=all"; else if (isint($2) && $2 + 0 > 0) print "--gpus=" $2; next }
    $1 == "SOPT" { if (NF != 2) { bad = 1; next } print "--storage-opt=" $2; next }
    $1 == "HOSTNAME" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--hostname=" $2; next }
    $1 == "USER" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--user=" $2; next }
    $1 == "WORKDIR" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--workdir=" $2; next }
    $1 == "TTY" { if (NF != 2) { bad = 1; next } if ($2 == "true") print "--tty"; next }
    $1 == "OPEN" { if (NF != 2) { bad = 1; next } if ($2 == "true") print "--interactive"; next }
    $1 == "INIT" { if (NF != 2) { bad = 1; next } if ($2 == "true") print "--init"; next }
    $1 == "RO" { if (NF != 2) { bad = 1; next } if ($2 == "true") print "--read-only"; next }
    $1 == "STOPSIG" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--stop-signal=" $2; next }
    $1 == "STOPTO" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) print "--stop-timeout=" $2; next }
    $1 == "NETMODE" { if (NF != 2) { bad = 1; next } netmode = $2; next }
    $1 == "RESTART" { if (NF != 2) { bad = 1; next } restart = $2; next }
    $1 == "RETRY" { if (NF != 2) { bad = 1; next } retry = $2; next }
    $1 == "MEM" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) print "--memory=" $2; next }
    $1 == "MEMRES" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) print "--memory-reservation=" $2; next }
    $1 == "NANO" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) printf "--cpus=%g\n", $2 / 1000000000; next }
    $1 == "CPUSHARES" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) print "--cpu-shares=" $2; next }
    $1 == "CPUSET" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--cpuset-cpus=" $2; next }
    $1 == "PIDSLIM" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 0) print "--pids-limit=" $2; next }
    $1 == "PRIV" { if (NF != 2) { bad = 1; next } if ($2 == "true") print "--privileged"; next }
    $1 == "PIDM" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--pid=" $2; next }
    $1 == "IPCM" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--ipc=" $2; next }
    $1 == "UTS" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--uts=" $2; next }
    $1 == "USERNS" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--userns=" $2; next }
    $1 == "CGP" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--cgroup-parent=" $2; next }
    $1 == "RT" { if (NF != 2) { bad = 1; next } if ($2 != "") print "--runtime=" $2; next }
    $1 == "SHM" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 > 67108864) print "--shm-size=" $2; next }
    $1 == "OOM" { if (NF != 2) { bad = 1; next } if (isint($2) && $2 + 0 != 0) print "--oom-score-adj=" $2; next }
    $1 == "HK" { if (NF != 2) { bad = 1; next } hkcmd = hk($2); next }
    $1 == "HKINT" { if (NF != 2) { bad = 1; next } hkint = $2 + 0; next }
    $1 == "HKTMO" { if (NF != 2) { bad = 1; next } hktmo = $2 + 0; next }
    $1 == "HKRET" { if (NF != 2) { bad = 1; next } hkret = $2 + 0; next }
    $1 == "HKSTART" { if (NF != 2) { bad = 1; next } hkstart = $2 + 0; next }
    { bad = 1 }
    END {
      if (bad) { print "the settings of the container could not be read (a value with a newline is not supported)" > "/dev/stderr"; exit 2 }
      if (nets == 0 && netmode != "" && netmode != "default") print "--network=" netmode
      if (restart != "" && restart != "no") { if (restart == "on-failure" && isint(retry) && retry + 0 > 0) print "--restart=on-failure:" retry; else print "--restart=" restart }
      if (hkcmd != "") { print "--health-cmd=" hkcmd; if (hkint > 0) print "--health-interval=" dur(hkint); if (hktmo > 0) print "--health-timeout=" dur(hktmo); if (hkret > 0) print "--health-retries=" hkret; if (hkstart > 0) print "--health-start-period=" dur(hkstart) }
    }
  ' "$tmp/clone.raw" > "$tmp/clone.flags" 2>"$tmp/err" || fail "the settings of $c could not be read for the pinned image: $(lastline "$tmp/err")"
  cid=''; wasrun=false
  while IFS='=' read -r k v; do case "$k" in id) cid=$v ;; run) wasrun=$v ;; esac; done < "$tmp/facts"
  case "$cid" in ''|*[!0-9a-f]*) fail "the container $c could not be read" ;; esac
  if ! $D image inspect "$ref" >/dev/null 2>&1; then
    echo "[step] Pulling $ref"
    $D pull "$ref" >/dev/null 2>&1 || fail "the image $ref could not be pulled (the data was restored)"
  fi
  old="$c-bosun-old"
  if $D inspect --type container --format '{{.Id}}' "$old" >/dev/null 2>&1; then fail "a container named $old exists (left over from an earlier restore); remove it first"; fi
  echo "[step] Recreating $c with $ref"
  newid=''
  rollback() {
    [ -z "$newid" ] || $D rm -f "$newid" >/dev/null 2>&1
    if ! $D rename "$old" "$c" >/dev/null 2>&1; then fail "$1; and the old container could not be renamed back (it is still $old)"; fi
    if [ "$wasrun" = true ]; then $D start "$c" >/dev/null 2>&1; fi
    fail "$1 (the old container $c was put back)"
  }
  $D rename "$c" "$old" >/dev/null 2>"$tmp/err" || fail "the container $c could not be renamed: $(lastline "$tmp/err")"
  set --
  while IFS= read -r a; do set -- "$@" "$a"; done < "$tmp/clone.flags"
  set -- "$@" "--name=$c" "$ref"
  while IFS= read -r a; do set -- "$@" "$a"; done < "$tmp/clone.cmd"
  newid=$($D create "$@" 2>"$tmp/err") || { newid=''; rollback "creating the container failed: $(lastline "$tmp/err")"; }
  newid=$(printf '%s\n' "$newid" | tail -n 1)
  case "$newid" in ''|*[!0-9a-f]*) newid=''; rollback 'docker create gave an unexpected answer' ;; esac
  if [ "$wasrun" = true ]; then
    $D stop "$old" >/dev/null 2>&1
    $D start "$newid" >/dev/null 2>"$tmp/err" || rollback "the new container could not be started: $(lastline "$tmp/err")"
    wait=${BOSUN_RECREATE_WAIT:-2}; case "$wait" in ''|*[!0-9]*) wait=2 ;; esac
    [ "$wait" -eq 0 ] || sleep "$wait"
    st=$($D inspect --type container --format '{{.State.Running}}' "$newid" 2>/dev/null)
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
