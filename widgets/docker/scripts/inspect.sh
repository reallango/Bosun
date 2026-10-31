#!/bin/sh
# Docker (Linux), dataset: one container in the form the edit dialog needs, as one JSON object
#   {"name","image","state","settings":{every key of the settings blob; scalars as strings, repeated keys as arrays of strings},
#    "risky":[reasons],"risky_text":"reasons joined by comma","preserved_text":"...","preserved":[what an edit copies from the container without showing it],"readonly_note":"..."}
# `settings` is exactly what container_recreate accepts back (settings the image already provides, such as its own environment
# variables, command or labels, are left out, so an edit does not copy them into the container). Docker's own templates print
# every value as a JSON string; this script only sorts the lines. Parameter: name.
fail() { echo "$*" >&2; exit 1; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid container name' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid container name'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
nl='
'

fmt='{{$c := .Config}}{{$h := .HostConfig}}ID {{json .Id}}
NAME {{json .Name}}
IMAGE {{json (index $c "Image")}}
IMGID {{.Image}}
STATE {{json .State.Status}}
{{range (index $c "Env")}}ENV {{json .}}
{{end}}CMDJ {{json (index $c "Cmd")}}
EPJ {{json (index $c "Entrypoint")}}
{{range (index $c "Cmd")}}CMD {{json .}}
{{end}}{{range (index $c "Entrypoint")}}EP {{json .}}
{{end}}{{range $k, $v := (index $c "Labels")}}LABEL {{json (printf "%s=%s" $k $v)}}
{{end}}{{range $p, $bs := (index $h "PortBindings")}}{{range $bs}}PORT {{json (index . "HostIp")}} {{json (index . "HostPort")}} {{json $p}}
{{end}}{{end}}{{range .Mounts}}{{if ne .Type "tmpfs"}}{{$ro := ""}}{{if not .RW}}{{$ro = ":ro"}}{{end}}{{if eq .Type "volume"}}MOUNT {{json (printf "%s:%s%s" (index . "Name") .Destination $ro)}}
{{else}}MOUNT {{json (printf "%s:%s%s" .Source .Destination $ro)}}
BIND {{json .Source}}
{{end}}{{end}}{{end}}{{range $p, $o := (index $h "Tmpfs")}}TMPFS {{if $o}}{{json (printf "%s:%s" $p $o)}}{{else}}{{json $p}}{{end}}
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
{{end}}{{range (index $h "DeviceCgroupRules")}}PRES {{json (printf "--device-cgroup-rule=%s" .)}}
{{end}}{{range (index $h "Ulimits")}}PRES {{json (printf "--ulimit=%s=%v:%v" .Name .Soft .Hard)}}
{{end}}{{range (index $h "GroupAdd")}}PRES {{json (printf "--group-add=%s" .)}}
{{end}}{{range $k, $v := (index $h "StorageOpt")}}PRES {{json (printf "--storage-opt=%s=%s" $k $v)}}
{{end}}SHM {{index $h "ShmSize"}}
OOM {{index $h "OomScoreAdj"}}
CGP {{json (index $h "CgroupParent")}}
RT {{json (index $h "Runtime")}}
{{if (index $h "VolumesFrom")}}UNM "volumes-from"
{{end}}{{if (index $h "Links")}}UNM "links"
{{end}}{{if (index $h "CpusetCpus")}}UNM "cpuset-cpus"
{{end}}{{if (index $h "DnsSearch")}}UNM "dns-search"
{{end}}{{if (index $h "DnsOptions")}}UNM "dns-option"
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
{{end}}USER {{json (index $c "User")}}
WORKDIR {{json (index $c "WorkingDir")}}
STOPSIG {{json (index $c "StopSignal")}}
HEALTHJ {{json (index $c "Healthcheck")}}
'

if ! facts=$($D inspect --type container --format "$fmt" "$name" 2>/dev/null); then fail "container $name not found or could not be inspected"; fi

# ---- the image's own defaults (what a container inherits and an edit must not copy) ----
imgid=''
while IFS= read -r line; do case "$line" in 'IMGID '*) imgid=${line#IMGID } ;; esac; done <<EOF
$facts
EOF
I_ENV=$nl; I_LABEL=$nl; I_CMDJ=''; I_EPJ=''; I_USER='""'; I_WORKDIR='""'; I_STOPSIG='null'; I_HEALTHJ='null'
case "$imgid" in
  ''|*[!0-9a-zA-Z:]*) ;;
  *)
    if ifacts=$($D image inspect --format "$ifmt" "$imgid" 2>/dev/null); then
      while IFS= read -r line; do
        tag=${line%% *}; rest=${line#* }
        case "$tag" in
          ENV) I_ENV="$I_ENV$rest$nl" ;;
          LABEL) I_LABEL="$I_LABEL$rest$nl" ;;
          CMDJ) I_CMDJ=$rest ;;
          EPJ) I_EPJ=$rest ;;
          USER) I_USER=$rest ;;
          WORKDIR) I_WORKDIR=$rest ;;
          STOPSIG) I_STOPSIG=$rest ;;
          HEALTHJ) I_HEALTHJ=$rest ;;
        esac
      done <<EOF
$ifacts
EOF
    fi ;;
esac

# ---- sort the lines of the container ----
unq() { u=${1#\"}; u=${u%\"}; }
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
RISKS=$nl
add_risk() { case "$RISKS" in *"$nl$1$nl"*) ;; *) RISKS="$RISKS$1$nl" ;; esac; }
is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 18 ]; }
dur() { # nanoseconds -> 30s / 500ms
  DUR=''
  if is_int "$1" && [ "$1" -gt 0 ]; then
    if [ $(($1 % 1000000000)) -eq 0 ]; then DUR="$(($1 / 1000000000))s"
    elif [ $(($1 % 1000000)) -eq 0 ]; then DUR="$(($1 / 1000000))ms"
    else DUR="${1}ns"; fi
  fi
}

ID=''; NAME='""'; IMAGE='""'; STATE='""'
ENVS=''; CMDT=''; EPT=''; LABELS=''; PORTS=''; VOLS=''; TMPFS=''; NETMODE='"bridge"'; ALIASES=''; NETNS=''
RP=''; RPN=0; HOSTNAME='""'; USERV='""'; WORKDIR='""'; MEM=''; NANO=''; DNS=''; EXTRAH=''; LOGT=''; LOGO=''; STOPSIG='null'; STOPTO=''
TTY=''; OPEN=''; INIT=''; RO=''; HEALTHJ='null'; HKIND=''; HARGS=''; HINT=''; HTO=''; HRET=''; HSTART=''
PRIV=''; PIDM=''; IPCM=''; CAPADD=''; CAPDROP=''; DEVICE=''; SECOPT=''; SYSCTL=''; GPU=''
PRES=''; COMPOSE=''; SHM=''; OOM=''; CGP=''; RT=''; UNM=''; CPUSHARES=''; PIDSLIM=''; MEMRES=''; UTS=''; USERNS=''
IP4=''; IP6=''; CMDJ=''; EPJ=''
j() { printf '%s' "${1:+$1,}$2"; }   # join JSON tokens with a comma
while IFS= read -r line; do
  case "$line" in *' '*) tag=${line%% *}; rest=${line#* } ;; *) continue ;; esac
  case "$tag" in
    ID) ID=$rest ;;
    NAME) unq "$rest"; NAME="\"${u#/}\"" ;;
    IMAGE) IMAGE=$rest ;;
    STATE) STATE=$rest ;;
    ENV) case "$I_ENV" in *"$nl$rest$nl"*) ;; *) ENVS=$(j "$ENVS" "$rest") ;; esac ;;
    CMDJ) CMDJ=$rest ;;
    EPJ) EPJ=$rest ;;
    CMD) CMDT=$(j "$CMDT" "$rest") ;;
    EP) EPT=$(j "$EPT" "$rest") ;;
    LABEL)
      case "$rest" in
        '"com.docker.compose.'*) COMPOSE=$(j "$COMPOSE" "\"label ${rest#\"}") ;;
        *) case "$I_LABEL" in *"$nl$rest$nl"*) ;; *) LABELS=$(j "$LABELS" "$rest") ;; esac ;;
      esac ;;
    PORT)
      set -f; set -- $rest; set +f
      if [ $# -eq 3 ]; then
        unq "$1"; pip=$u; unq "$2"; php=$u; unq "$3"; pct=$u
        case "$pip" in *:*) pip="[$pip]" ;; esac
        if [ -n "$pip" ]; then ptxt="$pip:$php:$pct"; elif [ -n "$php" ]; then ptxt="$php:$pct"; else ptxt=$pct; fi
        PORTS=$(j "$PORTS" "\"$ptxt\"")
      fi ;;
    MOUNT) VOLS=$(j "$VOLS" "$rest") ;;
    BIND) unq "$rest"; if sensitive "$u"; then add_risk "host path $u"; fi ;;
    TMPFS) TMPFS=$(j "$TMPFS" "$rest") ;;
    NETMODE) NETMODE=$rest ;;
    NETN) NETNS="$NETNS$rest$nl" ;;
    ALIAS) ALIASES="$ALIASES$rest$nl" ;;
    IP4) IP4="$IP4$rest$nl" ;;
    IP6) IP6="$IP6$rest$nl" ;;
    RP) RP=$rest ;;
    RPN) RPN=$rest ;;
    HOSTNAME) HOSTNAME=$rest ;;
    USER) USERV=$rest ;;
    WORKDIR) WORKDIR=$rest ;;
    MEM) MEM=$rest ;;
    NANO) NANO=$rest ;;
    DNS) DNS=$(j "$DNS" "$rest") ;;
    EXTRAHOST) EXTRAH=$(j "$EXTRAH" "$rest") ;;
    LOGT) LOGT=$rest ;;
    LOGO) LOGO=$(j "$LOGO" "$rest") ;;
    STOPSIG) STOPSIG=$rest ;;
    STOPTO) STOPTO=$rest ;;
    TTY) TTY=$rest ;;
    OPEN) OPEN=$rest ;;
    INIT) INIT=$rest ;;
    RO) RO=$rest ;;
    HEALTHJ) HEALTHJ=$rest ;;
    HKIND) HKIND=$rest ;;
    HARG) unq "$rest"; HARGS="${HARGS:+$HARGS }$u" ;;
    HINT) HINT=$rest ;;
    HTO) HTO=$rest ;;
    HRET) HRET=$rest ;;
    HSTART) HSTART=$rest ;;
    PRIV) PRIV=$rest ;;
    PIDM) PIDM=$rest ;;
    IPCM) IPCM=$rest ;;
    CAPADD) CAPADD=$(j "$CAPADD" "$rest"); unq "$rest"; add_risk "capability $u" ;;
    CAPDROP) CAPDROP=$(j "$CAPDROP" "$rest") ;;
    DEVICE) DEVICE=$(j "$DEVICE" "$rest"); unq "$rest"; add_risk "device $u" ;;
    SECOPT) SECOPT=$(j "$SECOPT" "$rest"); unq "$rest"; add_risk "security option $u" ;;
    SYSCTL) SYSCTL=$(j "$SYSCTL" "$rest"); unq "$rest"; add_risk "sysctl ${u%%=*}" ;;
    GPU) GPU=$rest ;;
    PRES) PRES=$(j "$PRES" "$rest") ;;
    SHM) SHM=$rest ;;
    OOM) OOM=$rest ;;
    CGP) CGP=$rest ;;
    RT) RT=$rest ;;
    UNM) unq "$rest"; UNM="${UNM:+$UNM, }$u" ;;
    CPUSHARES) CPUSHARES=$rest ;;
    PIDSLIM) PIDSLIM=$rest ;;
    MEMRES) MEMRES=$rest ;;
    UTS) UTS=$rest ;;
    USERNS) USERNS=$rest ;;
  esac
done <<EOF
$facts
EOF

# ---- derive the settings ----
unq "$NETMODE"; netmode=$u
case "$netmode" in default|'') netmode=bridge ;; esac
NETMODE="\"$netmode\""
[ "$netmode" != host ] || add_risk 'host network'
unq "$ID"; shortid=$(printf '%.12s' "$u")
unq "$NAME"; cname=$u

# network aliases of the primary network (the container's own short id is not one the person chose)
ALIAS_OUT=''
case "$netmode" in bridge|host|none) ;; *)
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    anet=${line%% *}; unq "$anet"; anet=$u
    [ "$anet" = "$netmode" ] || continue
    atok=${line#* }; unq "$atok"
    [ "$u" != "$shortid" ] && [ "$u" != "$cname" ] || continue
    ALIAS_OUT=$(j "$ALIAS_OUT" "$atok")
  done <<EOF
$ALIASES
EOF
  ;;
esac
# networks beyond the first are not editable
nnets=0; extranets=''
while IFS= read -r line; do
  [ -n "$line" ] || continue
  unq "$line"; nnets=$((nnets + 1))
  if [ "$u" != "$netmode" ] && { [ "$u" != bridge ] || [ "$netmode" != bridge ]; }; then extranets="${extranets:+$extranets }$u"; fi
done <<EOF
$NETNS
EOF
[ -z "$extranets" ] || UNM="${UNM:+$UNM, }also attached to the networks $extranets"

# command, entrypoint (only when they differ from what the image provides)
CMD_OUT=''; EP_OUT=''
[ "$CMDJ" = "$I_CMDJ" ] || CMD_OUT=$CMDT
if [ "$EPJ" != "$I_EPJ" ]; then
  if [ -n "$EPT" ]; then EP_OUT=$EPT; else EP_OUT='""'; fi
fi
# user, workdir, hostname, stop signal
[ "$USERV" = "$I_USER" ] && USER_OUT='""' || USER_OUT=$USERV
[ "$WORKDIR" = "$I_WORKDIR" ] && WORKDIR_OUT='""' || WORKDIR_OUT=$WORKDIR
unq "$HOSTNAME"; hn=$u
if [ "$hn" = "$shortid" ] || [ "$netmode" = host ]; then HOSTNAME_OUT='""'; else HOSTNAME_OUT=$HOSTNAME; fi
[ "$STOPSIG" = "$I_STOPSIG" ] && STOPSIG_OUT='""' || { case "$STOPSIG" in null) STOPSIG_OUT='""' ;; *) STOPSIG_OUT=$STOPSIG ;; esac; }
is_int "$STOPTO" && STOPTO_OUT="\"$STOPTO\"" || STOPTO_OUT='""'
# restart policy
unq "$RP"; rpname=$u
case "$rpname" in ''|no) restart=no ;; on-failure) restart=on-failure ;; always|unless-stopped) restart=$rpname ;; *) restart=no ;; esac
# limits
memory=''
if is_int "$MEM" && [ "$MEM" -gt 0 ]; then
  if [ $((MEM % 1073741824)) -eq 0 ]; then memory="$((MEM / 1073741824))g"
  elif [ $((MEM % 1048576)) -eq 0 ]; then memory="$((MEM / 1048576))m"
  else memory="${MEM}b"; fi
fi
cpus=''
if is_int "$NANO" && [ "$NANO" -gt 0 ]; then
  cw=$((NANO / 1000000000)); cf=$((NANO % 1000000000))
  if [ "$cf" -eq 0 ]; then cpus=$cw; else cf=$(printf '%09d' "$cf"); cf=${cf%"${cf##*[!0]}"}; cpus="$cw.$cf"; fi
fi
# logging (the default json-file driver without options is not shown)
unq "$LOGT"; logdriver=$u
[ -z "$LOGO" ] && [ "$logdriver" = json-file ] && logdriver=''
# booleans
[ "$TTY" = true ] && tty=true || tty=false
[ "$OPEN" = true ] && interactive=true || interactive=false
[ "$INIT" = true ] && init=true || init=false
[ "$RO" = true ] && readonly=true || readonly=false
[ "$PRIV" = true ] && { privileged=true; add_risk privileged; } || privileged=false
unq "$PIDM"; if [ "$u" = host ]; then pid=host; add_risk 'host PID namespace'; else pid=''; fi
unq "$IPCM"; if [ "$u" = host ]; then ipc=host; add_risk 'host IPC namespace'; else ipc=''; fi
gpus=''
case "$GPU" in -1) gpus=all ;; ''|0|*[!0-9]*) ;; *) gpus=$GPU ;; esac
# health check (only when it differs from the image's)
hcmd=''; hint=''; hto=''; hret=''
if [ "$HEALTHJ" != "$I_HEALTHJ" ] && [ "$HEALTHJ" != null ] && [ -n "$HKIND" ]; then
  unq "$HKIND"
  case "$u" in CMD|CMD-SHELL) hcmd=$HARGS ;; esac
  dur "$HINT"; hint=$DUR; dur "$HTO"; hto=$DUR
  is_int "$HRET" && [ "$HRET" -gt 0 ] && hret=$HRET
  dur "$HSTART"; [ -z "$DUR" ] || UNM="${UNM:+$UNM, }health check start period"
fi
# the rest of what Bosun cannot show
is_int "$CPUSHARES" && [ "$CPUSHARES" -gt 0 ] && UNM="${UNM:+$UNM, }cpu-shares"
is_int "$PIDSLIM" && [ "$PIDSLIM" -gt 0 ] && UNM="${UNM:+$UNM, }pids-limit"
is_int "$MEMRES" && [ "$MEMRES" -gt 0 ] && UNM="${UNM:+$UNM, }memory-reservation"
unq "$UTS"; [ "$u" != host ] || UNM="${UNM:+$UNM, }host UTS namespace"
unq "$USERNS"; [ "$u" != host ] || UNM="${UNM:+$UNM, }host user namespace"

# preserved settings (copied by an edit, not editable)
PRES_OUT=''
[ -z "$COMPOSE" ] || PRES_OUT=$COMPOSE
[ -z "$PRES" ] || PRES_OUT=$(j "$PRES_OUT" "$PRES")
if [ "$rpname" = on-failure ] && is_int "$RPN" && [ "$RPN" -gt 0 ]; then PRES_OUT=$(j "$PRES_OUT" "\"restart on-failure max retries $RPN\""); fi
is_int "$SHM" && [ "$SHM" -gt 0 ] && [ "$SHM" -ne 67108864 ] && PRES_OUT=$(j "$PRES_OUT" "\"--shm-size=$SHM\"")
case "$OOM" in 0|''|*[!0-9-]*) ;; *) PRES_OUT=$(j "$PRES_OUT" "\"--oom-score-adj=$OOM\"") ;; esac
unq "$CGP"; [ -z "$u" ] || PRES_OUT=$(j "$PRES_OUT" "\"--cgroup-parent=$u\"")
unq "$RT"; case "$u" in ''|runc|null) ;; *) PRES_OUT=$(j "$PRES_OUT" "\"--runtime=$u\"") ;; esac
while IFS= read -r line; do
  [ -n "$line" ] || continue
  unq "${line%% *}"; [ "$u" = "$netmode" ] || continue
  atok=${line#* }; unq "$atok"; PRES_OUT=$(j "$PRES_OUT" "\"--ip=$u\"")
done <<EOF
$IP4
EOF
while IFS= read -r line; do
  [ -n "$line" ] || continue
  unq "${line%% *}"; [ "$u" = "$netmode" ] || continue
  atok=${line#* }; unq "$atok"; PRES_OUT=$(j "$PRES_OUT" "\"--ip6=$u\"")
done <<EOF
$IP6
EOF

# ---- the answer ----
note=''
[ -z "$UNM" ] || note="Not shown here and not kept when the container is edited: $UNM."
note=$(printf '%s' "$note" | tr -d '[:cntrl:]' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
risky_out=''
while IFS= read -r r; do
  [ -n "$r" ] || continue
  risky_out=$(j "$risky_out" "\"$r\"")
done <<EOF
$RISKS
EOF
printf '{"name":%s,"image":%s,"state":%s,' "$NAME" "$IMAGE" "$STATE"
printf '"settings":{"name":%s,"image":%s,"cmd":[%s],"entrypoint":[%s],"env":[%s],"port":[%s],"volume":[%s],"tmpfs":[%s],"label":[%s],' \
  "$NAME" "$IMAGE" "$CMD_OUT" "$EP_OUT" "$ENVS" "$PORTS" "$VOLS" "$TMPFS" "$LABELS"
printf '"network":%s,"network_alias":[%s],"restart":"%s","hostname":%s,"user":%s,"workdir":%s,"memory":"%s","cpus":"%s",' \
  "$NETMODE" "$ALIAS_OUT" "$restart" "$HOSTNAME_OUT" "$USER_OUT" "$WORKDIR_OUT" "$memory" "$cpus"
printf '"dns":[%s],"add_host":[%s],"log_driver":"%s","log_opt":[%s],"stop_signal":%s,"stop_timeout":%s,' \
  "$DNS" "$EXTRAH" "$logdriver" "$LOGO" "$STOPSIG_OUT" "$STOPTO_OUT"
printf '"tty":"%s","interactive":"%s","init":"%s","read_only":"%s",' "$tty" "$interactive" "$init" "$readonly"
printf '"health_cmd":"%s","health_interval":"%s","health_timeout":"%s","health_retries":"%s",' \
  "$(printf '%s' "$hcmd" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" "$hint" "$hto" "$hret"
printf '"privileged":"%s","pid":"%s","ipc":"%s","cap_add":[%s],"cap_drop":[%s],"device":[%s],"security_opt":[%s],"sysctl":[%s],"gpus":"%s"},' \
  "$privileged" "$pid" "$ipc" "$CAPADD" "$CAPDROP" "$DEVICE" "$SECOPT" "$SYSCTL" "$gpus"
# the same lists as one line of text (the tokens are JSON strings already: drop the outer quotes, join with ", ")
txt() { t1=${1#\"}; t1=${t1%\"}; printf '%s' "$t1" | sed 's/","/, /g'; }
printf '"risky":[%s],"risky_text":"%s","preserved":[%s],"preserved_text":"%s","readonly_note":"%s"}\n' \
  "$risky_out" "$(txt "$risky_out")" "$PRES_OUT" "$(txt "$PRES_OUT")" "$note"
