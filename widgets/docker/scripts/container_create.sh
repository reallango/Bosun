#!/bin/sh
# Docker (Linux): creates and starts a container from the settings blob (one `key=value` per line, see docs/plans/docker-manager.md).
# The blob is data: every line is validated and becomes exactly one argument of `docker create` (nothing is ever run through a
# shell or eval). Risky options (privileged, host namespaces, extra capabilities, devices, host paths such as /etc or the Docker
# socket, host networking) are refused unless the parameter allow_risky is true.
# Parameters: settings (text), allow_risky (true/false).
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

[ -n "$S_IMAGE" ] || fail 'image is required'
[ -z "$S_NAME" ] || set -- "$@" "--name=$S_NAME"
[ -z "$S_RESTART" ] || set -- "$@" "--restart=$S_RESTART"
set -- "$@" "$S_IMAGE"
while IFS= read -r c; do
  case "$c" in +*) set -- "$@" "${c#+}" ;; esac
done <<EOS
$EPREST$CMDL
EOS

D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
errf=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$errf"' EXIT
lastline() { tail -n 1 "$errf" | tr -d '\r' | cut -c1-300; }

echo 'PROGRESS 1/4'
echo "[step] Checking the image $S_IMAGE"
if ! $D image inspect --format '{{.Id}}' "$S_IMAGE" >/dev/null 2>&1; then
  echo "[step] Pulling $S_IMAGE"; $D pull "$S_IMAGE" >/dev/null 2>"$errf" || fail "pulling $S_IMAGE failed: $(lastline)"
fi
echo 'PROGRESS 2/4'
echo "[step] Creating the container"
id=$($D create "$@" 2>"$errf") || fail "creating the container failed: $(lastline)"
id=$(printf '%s\n' "$id" | tail -n 1)
case "$id" in ''|*[!0-9a-f]*) fail 'docker create gave an unexpected answer' ;; esac
echo 'PROGRESS 3/4'
echo '[step] Starting the container'
if ! $D start "$id" >/dev/null 2>"$errf"; then
  msg=$(lastline)
  $D rm -f "$id" >/dev/null 2>&1
  fail "the container could not be started: $msg"
fi
echo 'PROGRESS 4/4'
cname=$($D inspect --format '{{.Name}}' "$id" 2>/dev/null)
cname=${cname#/}
echo "DONE created ${cname:-$id}"
exit 0
