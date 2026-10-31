#!/bin/sh
# Docker (Linux): replaces a container by a new one built from the settings blob (the full desired state, same format as
# container_create). Steps: validate everything first; pull the image when it is missing; rename the old container to
# <name>-bosun-old; create the new one (settings Bosun does not manage, such as the docker-compose labels, ulimits and shm-size,
# are copied from the old container); stop the old one and start the new one; the old container is removed only when the new one
# runs. On any failure the new container is removed and the old one is put back (renamed back, started when it was running).
# Parameters: name (the existing container), settings (text), allow_risky (true/false).
# Parameter `name` is the container to replace; a `name=` line in the settings renames it.
# >>> settings parser (the same text in container_create.sh and container_recreate.sh; a test compares them)
SETTINGS=$BOSUN_PARAM_settings
nl='
'
cr=$(printf '\r')
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
valid_name() { case "$1" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) return 1 ;; esac; [ "${#1}" -le 128 ]; }
valid_ref() { case "$1" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9._/:@-]*) return 1 ;; esac; [ "${#1}" -le 255 ]; }
is_num() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 9 ]; }
is_abs() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in *[[:cntrl:]]*|*:*) return 1 ;; esac; return 0; }
valid_dur() { d1=${1%%[a-z]*}; d2=${1#"$d1"}; is_num "$d1" || return 1; case "$d2" in ns|us|ms|s|m|h) return 0 ;; esac; return 1; }
valid_portnum() { case "$1" in ''|*[!0-9-]*|-*|*-|*-*-*) return 1 ;; esac; [ "${#1}" -le 11 ]; }
RISKY=''
add_risk() { case "$RISKY" in *"$1"*) ;; *) RISKY="${RISKY:+$RISKY, }$1" ;; esac; }
# Is this host path (after resolving . and .. in its text) a sensitive one, or inside one? The path arrives in the environment, never in the awk program.
sensitive() {
  P=$1 awk 'BEGIN {
    n = split(ENVIRON["P"], a, "/"); k = 0
    for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (k > 0) k--; continue } k++; s[k] = a[i] }
    if (k == 0) exit 0
    p = ""; for (i = 1; i <= k; i++) p = p "/" s[i]
    b = tolower(s[k]); if (b == "docker.sock" || b == "containerd.sock") exit 0
    n = split("/etc /root /proc /sys /boot /usr /var/lib/docker", r, " ")
    for (i = 1; i <= n; i++) if (p == r[i] || index(p, r[i] "/") == 1) exit 0
    if (k >= 3 && s[1] == "home" && s[3] == ".ssh") exit 0
    exit 1 }'
}
host_path_risk() {
  if sensitive "$1"; then add_risk "host path $1"; return 0; fi
  hp1=$(readlink -f -- "$1" 2>/dev/null)
  if [ -n "$hp1" ] && [ "$hp1" != "$1" ] && sensitive "$hp1"; then add_risk "host path $1 (is $hp1)"; fi
  return 0
}
# [hostip:]hostport:containerport[/tcp|udp]  (hostport may be empty for a random port; a lone containerport is accepted)
parse_port() {
  pp=$1; pproto=''; phip=''; php=''
  case "$pp" in */tcp|*/udp|*/sctp) pproto=/${pp##*/}; pp=${pp%/*} ;; esac
  case "$pp" in \[*\]:*) phip=${pp%%]:*}]; pp=${pp#*]:} ;; esac
  if [ -z "$phip" ]; then
    case "$pp" in *:*:*:*) return 1 ;; *:*:*) phip=${pp%%:*}; pp=${pp#*:} ;; esac
  else
    case "$pp" in *:*:*) return 1 ;; esac
  fi
  case "$pp" in *:*) php=${pp%%:*}; pcp=${pp#*:} ;; *) pcp=$pp ;; esac
  case "$phip" in
    '') ;;
    \[*\]) ph1=${phip#\[}; ph1=${ph1%\]}; case "$ph1" in ''|*[!0-9a-fA-F:]*) return 1 ;; esac ;;
    *[!0-9.]*|.*|*.|*..*) return 1 ;;
    *.*.*.*.*) return 1 ;;
    *.*.*.*) ;;
    *) return 1 ;;
  esac
  [ -z "$php" ] || valid_portnum "$php" || return 1
  valid_portnum "$pcp" || return 1
  if [ -n "$phip" ]; then PORTARG="$phip:$php:$pcp$pproto"
  elif [ -n "$php" ]; then PORTARG="$php:$pcp$pproto"
  else PORTARG="$pcp$pproto"; fi
  return 0
}
SEEN=' '
once() { case "$SEEN" in *" $1 "*) fail "$1 is given twice" ;; esac; SEEN="$SEEN$1 "; }
S_RESTART=''; S_NAME=''; S_IMAGE=''; S_NETWORK=''; CMDL=''; EPREST=''; EPFIRST=''; EPN=0; EPCLEAR=0; lineno=0
set --
while IFS= read -r line; do
  lineno=$((lineno + 1))
  [ "$lineno" -le 500 ] || fail 'the settings have too many lines (at most 500)'
  line=${line%"$cr"}
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *[![:space:]]*) ;; *) continue ;; esac
  [ "${#line}" -le 1000 ] || fail "settings line $lineno is longer than 1000 characters"
  case "$line" in *=*) ;; *) fail "settings line $lineno has no '='" ;; esac
  k=${line%%=*}; v=${line#*=}
  case "$k" in
    name) once name; [ -n "$v" ] || continue
      valid_name "$v" || fail 'name: use letters, digits, _ . - only (at most 128 characters, starting with a letter or digit)'
      S_NAME=$v ;;
    image) once image; [ -n "$v" ] || continue
      valid_ref "$v" || fail 'image: not a valid image reference'
      S_IMAGE=$v ;;
    cmd) [ -z "$v" ] || CMDL="$CMDL+$v$nl" ;;
    entrypoint)
      if [ "$EPN" -eq 0 ]; then
        EPN=1; if [ -z "$v" ]; then EPCLEAR=1; else EPFIRST=$v; fi
      elif [ -n "$v" ]; then
        [ "$EPCLEAR" -eq 0 ] || fail 'entrypoint: an empty first line clears the entrypoint and cannot be followed by arguments'
        EPREST="$EPREST+$v$nl"
      fi ;;
    env) [ -n "$v" ] || continue
      case "$v" in *=*) ;; *) fail 'env: each entry needs the form KEY=value' ;; esac
      case "${v%%=*}" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_.-]*) fail 'env: invalid variable name (letters, digits and _ only, not starting with a digit)' ;; esac
      set -- "$@" "--env=$v" ;;
    port) [ -n "$v" ] || continue
      parse_port "$v" || fail 'port: use [hostip:]hostport:containerport[/tcp|udp]'
      set -- "$@" "--publish=$PORTARG" ;;
    volume) [ -n "$v" ] || continue
      case "$v" in *:*) ;; *) fail 'volume: use source:target[:ro]' ;; esac
      vsrc=${v%%:*}; vrest=${v#*:}; vdst=${vrest%%:*}; vmode=''
      case "$vrest" in *:*) vmode=${vrest#*:} ;; esac
      case "$vmode" in ''|ro|rw) ;; *) fail 'volume: the mode can only be ro or rw' ;; esac
      is_abs "$vdst" || fail 'volume: the target must be an absolute path'
      case "$vsrc" in
        /*) is_abs "$vsrc" || fail 'volume: invalid host path'; host_path_risk "$vsrc" ;;
        *) valid_name "$vsrc" || fail 'volume: the source must be a volume name or an absolute host path' ;;
      esac
      set -- "$@" "--volume=$v" ;;
    tmpfs) [ -n "$v" ] || continue
      is_abs "${v%%:*}" || fail 'tmpfs: the target must be an absolute path'
      case "$v" in *:*) case "${v#*:}" in *[!A-Za-z0-9=,_.]*) fail 'tmpfs: invalid options' ;; esac ;; esac
      set -- "$@" "--tmpfs=$v" ;;
    label) [ -n "$v" ] || continue
      case "$v" in *=*) ;; *) fail 'label: use key=value' ;; esac
      case "${v%%=*}" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_./-]*) fail 'label: invalid key' ;; esac
      set -- "$@" "--label=$v" ;;
    network) once network; [ -n "$v" ] || continue
      case "$v" in bridge|none) ;; host) add_risk 'host network' ;; *) valid_name "$v" || fail 'network: invalid network name' ;; esac
      S_NETWORK=$v; set -- "$@" "--network=$v" ;;
    network_alias) [ -n "$v" ] || continue
      valid_name "$v" || fail 'network_alias: invalid alias'
      set -- "$@" "--network-alias=$v" ;;
    restart) once restart; [ -n "$v" ] || continue
      case "$v" in no|always|unless-stopped|on-failure) ;; on-failure:*) is_num "${v#on-failure:}" || fail 'restart: invalid retry count' ;; *) fail 'restart: use no, always, unless-stopped, on-failure or on-failure:N' ;; esac
      S_RESTART=$v ;;
    hostname) once hostname; [ -n "$v" ] || continue
      valid_name "$v" || fail 'hostname: invalid host name'
      set -- "$@" "--hostname=$v" ;;
    user) once user; [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z0-9_.:-]*) fail 'user: use a name or uid[:gid]' ;; esac
      set -- "$@" "--user=$v" ;;
    workdir) once workdir; [ -n "$v" ] || continue
      is_abs "$v" || fail 'workdir: must be an absolute path'
      set -- "$@" "--workdir=$v" ;;
    memory) once memory; [ -n "$v" ] || continue
      case "${v%[bkmgBKMG]}" in ''|*[!0-9]*) fail 'memory: use a number with an optional unit, e.g. 512m or 2g' ;; esac
      [ "${#v}" -le 12 ] || fail 'memory: the number is too long'
      case "$v" in *[!0-9]*) ;; *) v="${v}m" ;; esac
      set -- "$@" "--memory=$v" ;;
    cpus) once cpus; [ -n "$v" ] || continue
      case "$v" in
        *.*) is_num "${v%%.*}" && is_num "${v#*.}" || fail 'cpus: use a decimal number, e.g. 1.5' ;;
        *) is_num "$v" || fail 'cpus: use a decimal number, e.g. 1.5' ;;
      esac
      set -- "$@" "--cpus=$v" ;;
    dns) [ -n "$v" ] || continue
      case "$v" in *[!0-9A-Fa-f:.]*) fail 'dns: use an IP address' ;; esac
      set -- "$@" "--dns=$v" ;;
    add_host) [ -n "$v" ] || continue
      case "$v" in *:*) ;; *) fail 'add_host: use host:ip' ;; esac
      case "$v" in *[!A-Za-z0-9._:-]*) fail 'add_host: use host:ip' ;; esac
      set -- "$@" "--add-host=$v" ;;
    log_driver) once log_driver; [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z0-9_.-]*) fail 'log_driver: invalid driver name' ;; esac
      set -- "$@" "--log-driver=$v" ;;
    log_opt) [ -n "$v" ] || continue
      case "$v" in *=*) ;; *) fail 'log_opt: use key=value' ;; esac
      case "${v%%=*}" in ''|*[!A-Za-z0-9_.-]*) fail 'log_opt: invalid key' ;; esac
      set -- "$@" "--log-opt=$v" ;;
    stop_signal) once stop_signal; [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z0-9]*) fail 'stop_signal: use a signal name or number' ;; esac
      set -- "$@" "--stop-signal=$v" ;;
    stop_timeout) once stop_timeout; [ -n "$v" ] || continue
      is_num "$v" || fail 'stop_timeout: use a number of seconds'
      set -- "$@" "--stop-timeout=$v" ;;
    tty|interactive|init|read_only|privileged) once "$k"
      case "$v" in
        true) case "$k" in
            tty) set -- "$@" --tty ;;
            interactive) set -- "$@" --interactive ;;
            init) set -- "$@" --init ;;
            read_only) set -- "$@" --read-only ;;
            privileged) set -- "$@" --privileged; add_risk privileged ;;
          esac ;;
        false|'') ;;
        *) fail "$k: use true or false" ;;
      esac ;;
    health_cmd) once health_cmd; [ -n "$v" ] || continue
      set -- "$@" "--health-cmd=$v" ;;
    health_interval|health_timeout) once "$k"; [ -n "$v" ] || continue
      valid_dur "$v" || fail "$k: use a duration such as 30s or 1m"
      set -- "$@" "--health-${k#health_}=$v" ;;
    health_retries) once health_retries; [ -n "$v" ] || continue
      is_num "$v" || fail 'health_retries: use a number'
      set -- "$@" "--health-retries=$v" ;;
    pid|ipc) once "$k"
      case "$v" in
        host) set -- "$@" "--$k=host"; if [ "$k" = pid ]; then add_risk 'host PID namespace'; else add_risk 'host IPC namespace'; fi ;;
        '') ;;
        *) fail "$k: only host is supported" ;;
      esac ;;
    cap_add) [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z_]*) fail 'cap_add: invalid capability name' ;; esac
      add_risk "capability $v"; set -- "$@" "--cap-add=$v" ;;
    cap_drop) [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z_]*) fail 'cap_drop: invalid capability name' ;; esac
      set -- "$@" "--cap-drop=$v" ;;
    device) [ -n "$v" ] || continue
      case "$v" in /dev/*) ;; *) fail 'device: must start with /dev/' ;; esac
      case "$v" in *[!A-Za-z0-9_./:-]*|*..*) fail 'device: invalid device path' ;; esac
      add_risk "device $v"; set -- "$@" "--device=$v" ;;
    security_opt) [ -n "$v" ] || continue
      case "$v" in *[!A-Za-z0-9_.:=/,@-]*) fail 'security_opt: invalid option' ;; esac
      add_risk "security option $v"; set -- "$@" "--security-opt=$v" ;;
    sysctl) [ -n "$v" ] || continue
      case "$v" in *=*) ;; *) fail 'sysctl: use key=value' ;; esac
      case "${v%%=*}" in ''|*[!A-Za-z0-9_.]*) fail 'sysctl: invalid key' ;; esac
      case "${v#*=}" in *[[:cntrl:]]*) fail 'sysctl: invalid value' ;; esac
      add_risk "sysctl ${v%%=*}"; set -- "$@" "--sysctl=$v" ;;
    gpus) once gpus; [ -n "$v" ] || continue
      case "$v" in all) ;; *) is_num "$v" || fail 'gpus: use all or a number' ;; esac
      set -- "$@" "--gpus=$v" ;;
    *) fail "unknown setting '$(printf '%.40s' "$k")'" ;;
  esac
done <<EOS
$SETTINGS
EOS
if [ "$EPCLEAR" -eq 1 ]; then set -- "$@" '--entrypoint='; elif [ -n "$EPFIRST" ]; then set -- "$@" "--entrypoint=$EPFIRST"; fi
case "$BOSUN_PARAM_allow_risky" in
  true) ;;
  *) [ -z "$RISKY" ] || fail "needs the permission to use elevated container options: $RISKY" ;;
esac
# <<< settings parser

OLD=$BOSUN_PARAM_name
valid_name "$OLD" || fail 'invalid container name'

D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
errf=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$errf"' EXIT
lastline() { tail -n 1 "$errf" | tr -d '\r' | cut -c1-300; }
WAIT=${BOSUN_RECREATE_WAIT:-2}; is_num "$WAIT" || WAIT=2

echo 'PROGRESS 1/6'
# The facts about the old container come as lines that start with a random token, so a label value cannot forge one.
tok=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ "${#tok}" -ge 12 ] || tok="bsb$$x$(date +%s)"
fmt0='{{$T := "@T@"}}{{$T}} ID {{.Id}}
{{$T}} RUN {{.State.Running}}
{{$T}} IMG {{.Config.Image}}
{{range $k, $v := .Config.Labels}}{{$T}} LBL {{$k}}={{$v}}
{{end}}{{range .HostConfig.DeviceCgroupRules}}{{$T}} DCR {{.}}
{{end}}{{range .HostConfig.Ulimits}}{{$T}} ULI {{.Name}}={{.Soft}}:{{.Hard}}
{{end}}{{$T}} SHM {{.HostConfig.ShmSize}}
{{range .HostConfig.GroupAdd}}{{$T}} GRP {{.}}
{{end}}{{$T}} RPN {{.HostConfig.RestartPolicy.Name}} {{.HostConfig.RestartPolicy.MaximumRetryCount}}
{{$T}} OOM {{.HostConfig.OomScoreAdj}}
{{$T}} CGP {{.HostConfig.CgroupParent}}
{{$T}} RT {{.HostConfig.Runtime}}
{{range $k, $v := index .HostConfig "StorageOpt"}}{{$T}} SOP {{$k}}={{$v}}
{{end}}{{range $n, $e := .NetworkSettings.Networks}}{{with $e.IPAMConfig}}{{$T}} IP4 {{$n}} {{.IPv4Address}}
{{$T}} IP6 {{$n}} {{.IPv6Address}}
{{end}}{{end}}'
fmt=$(printf '%s' "$fmt0" | sed "s/@T@/$tok/g")
if ! facts=$($D inspect --type container --format "$fmt" "$OLD" 2>"$errf"); then
  fail "the container $OLD was not found or could not be inspected: $(lastline)"
fi
OLDID=''; WASRUN=false; OLDIMG=''
while IFS= read -r line; do
  case "$line" in "$tok "*) ;; *) continue ;; esac
  rest=${line#"$tok "}; t=${rest%% *}; val=${rest#* }
  case "$t" in
    ID) OLDID=$val ;;
    RUN) WASRUN=$val ;;
    IMG) OLDIMG=$val ;;
    LBL) case "$val" in com.docker.compose.*=*) set -- "$@" "--label=$val" ;; esac ;;
    DCR) case "$val" in *[![:alnum:]*:[:space:]]*|'') ;; *) set -- "$@" "--device-cgroup-rule=$val" ;; esac ;;
    ULI) case "$val" in *[!A-Za-z0-9=:-]*|'') ;; *) set -- "$@" "--ulimit=$val" ;; esac ;;
    SHM) is_num "$val" && [ "$val" -ne 67108864 ] && [ "$val" -gt 0 ] && set -- "$@" "--shm-size=$val" ;;
    GRP) case "$val" in *[!A-Za-z0-9_.-]*|'') ;; *) set -- "$@" "--group-add=$val" ;; esac ;;
    RPN) rpn=${val%% *}; rpc=${val#* } ;;
    OOM) case "$val" in 0|''|*[!0-9-]*) ;; *) set -- "$@" "--oom-score-adj=$val" ;; esac ;;
    CGP) case "$val" in /*) is_abs "$val" && set -- "$@" "--cgroup-parent=$val" ;; esac ;;
    RT) case "$val" in ''|runc|*[!A-Za-z0-9_.-]*) ;; *) set -- "$@" "--runtime=$val" ;; esac ;;
    SOP) case "$val" in *=*) case "$val" in *[!A-Za-z0-9_.=/-]*) ;; *) set -- "$@" "--storage-opt=$val" ;; esac ;; esac ;;
    IP4|IP6)
      pnet=${val%% *}; pip=${val#* }
      case "$pip" in ''|*[!0-9A-Fa-f:.]*) ;; *)
        if [ -n "$S_NETWORK" ] && [ "$pnet" = "$S_NETWORK" ]; then
          if [ "$t" = IP4 ]; then set -- "$@" "--ip=$pip"; else set -- "$@" "--ip6=$pip"; fi
        fi ;;
      esac ;;
  esac
done <<EOS
$facts
EOS
case "$OLDID" in ''|*[!0-9a-f]*) fail "the container $OLD could not be read" ;; esac

NEWNAME=${S_NAME:-$OLD}
IMG=${S_IMAGE:-$OLDIMG}
valid_ref "$IMG" || fail 'the image of the container is unknown, give one in the settings (image=...)'
if [ -n "$S_RESTART" ]; then
  if [ "$S_RESTART" = on-failure ] && [ "$rpn" = on-failure ] && is_num "$rpc" && [ "$rpc" -gt 0 ]; then S_RESTART="on-failure:$rpc"; fi
  set -- "$@" "--restart=$S_RESTART"
fi
set -- "$@" "--name=$NEWNAME" "$IMG"
while IFS= read -r c; do
  case "$c" in +*) set -- "$@" "${c#+}" ;; esac
done <<EOS
$EPREST$CMDL
EOS

# Before anything is touched: the image must be here (a bad image fails now, with the old container still running).
if ! $D image inspect --format '{{.Id}}' "$IMG" >/dev/null 2>&1; then
  $D pull "$IMG" >/dev/null 2>"$errf" || fail "pulling $IMG failed (the old container was not changed): $(lastline)"
fi
BACKUP="$OLD-bosun-old"
if $D inspect --type container --format '{{.Id}}' "$BACKUP" >/dev/null 2>&1; then
  fail "a container named $BACKUP exists (left over from an earlier edit); remove it first"
fi
echo 'PROGRESS 2/6'

NEWID=''
# Put the old container back: remove the new one, rename the old one back, start it when it was running.
rollback() {
  [ -z "$NEWID" ] || $D rm -f "$NEWID" >/dev/null 2>&1
  if ! $D rename "$BACKUP" "$OLD" >/dev/null 2>"$errf"; then
    fail "$1; and the old container could not be renamed back (it is still there as $BACKUP): $(lastline)"
  fi
  if [ "$WASRUN" = true ]; then $D start "$OLD" >/dev/null 2>&1; fi
  fail "$1 (the old container $OLD was restored)"
}

$D rename "$OLD" "$BACKUP" >/dev/null 2>"$errf" || fail "the container could not be renamed: $(lastline)"
echo 'PROGRESS 3/6'
NEWID=$($D create "$@" 2>"$errf") || { NEWID=''; rollback "creating the new container failed: $(lastline)"; }
NEWID=$(printf '%s\n' "$NEWID" | tail -n 1)
case "$NEWID" in ''|*[!0-9a-f]*) NEWID=''; rollback 'docker create gave an unexpected answer' ;; esac
echo 'PROGRESS 4/6'
if [ "$WASRUN" = true ]; then
  $D stop "$BACKUP" >/dev/null 2>"$errf" || rollback "the old container could not be stopped: $(lastline)"
fi
$D start "$NEWID" >/dev/null 2>"$errf" || rollback "the new container could not be started: $(lastline)"
echo 'PROGRESS 5/6'
[ "$WAIT" -eq 0 ] || sleep "$WAIT"
state=$($D inspect --type container --format '{{.State.Running}} {{.State.Restarting}}' "$NEWID" 2>/dev/null)
[ "$state" = 'true false' ] || rollback 'the new container did not stay running'
if $D rm -f "$BACKUP" >/dev/null 2>"$errf"; then
  echo 'PROGRESS 6/6'
  echo "DONE recreated $NEWNAME"
else
  echo 'PROGRESS 6/6'
  echo "DONE recreated $NEWNAME (the old container could not be removed and remains as $BACKUP: $(lastline))"
fi
exit 0
