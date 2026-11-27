#!/bin/sh
# Docker (Linux): updates one standalone container to the newest image of the reference it runs, with a health check and an
# automatic rollback. Steps: read the container and the image it runs; refuse Bosun's own container; pull the reference; when
# the pulled image is the same as the running one nothing is touched; otherwise rebuild the container with the same settings
# on the new image (the export reader and writer below build a docker create command from the old container, the same text
# export_run.sh uses), renaming the old container to <name>-bosun-old first, start the new one, then wait up to health_timeout
# seconds for it to be running and, when it defines a healthcheck, healthy. On a failure the new container is removed and the
# old one is put back (renamed back, started when it was running) and the action fails with "rolled back: <reason>". The
# previous image is never removed (Settings → Updates keeps one; general image clean-up is the person's). Parameters: name,
# health_timeout (seconds, default 180).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
lastline() { tr -d '\r' < "$errf" | sed '/^$/d' | tail -n 3 | tr '\n' ' ' | cut -c1-400; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid container name' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid container name'
ht=${BOSUN_PARAM_health_timeout:-180}
case "$ht" in ''|*[!0-9]*) fail 'health_timeout must be a number of seconds' ;; esac
[ "$ht" -le 600 ] || fail 'health_timeout must be at most 600 seconds'
POLL=${BOSUN_UPDATE_POLL:-2}; case "$POLL" in ''|*[!0-9]*) POLL=2 ;; esac
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
errf=$(mktemp) || fail 'cannot create a temporary file'
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -f "$errf"; rm -rf "$tmp"' EXIT

# The repository of an image reference (no tag, no digest), to recognise Bosun's own image.
repo_of() { r=${1%%@*}; case "${r##*/}" in *:*) r=${r%:*} ;; esac; printf '%s' "$r"; }
case "$name" in bosun) fail "this is Bosun's own container; update it from Settings → Updates" ;; esac
image=$($D inspect --type container --format '{{.Config.Image}}' "$name" 2>"$errf") || fail "the container $name was not found or could not be inspected: $(lastline)"
case "$(repo_of "$image")" in bosun|*/bosun) fail "this is Bosun's own container; update it from Settings → Updates" ;; esac
curid=$($D inspect --type container --format '{{.Image}}' "$name" 2>/dev/null)
wasrun=$($D inspect --type container --format '{{.State.Running}}' "$name" 2>/dev/null)
case "$curid" in ''|*[!0-9a-zA-Z:]*) fail 'the image of the container could not be read' ;; esac
case "$wasrun" in true|false) ;; *) wasrun=true ;; esac

echo 'PROGRESS 1/6'; echo "[step] Pulling $image"
$D pull "$image" >/dev/null 2>"$errf" || fail "pulling $image failed (the container was not changed): $(lastline)"
newid=$($D image inspect --format '{{.Id}}' "$image" 2>"$errf") || fail "the pulled image $image could not be read: $(lastline)"
case "$newid" in ''|*[!0-9a-zA-Z:]*) fail 'docker image inspect gave an unexpected answer' ;; esac
if [ "$newid" = "$curid" ]; then
  echo 'PROGRESS 6/6'; echo "DONE already up to date: $name"; exit 0
fi
echo 'PROGRESS 2/6'; echo "[step] The image changed; reading the settings of $name"
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
collect "$name" "$tmp/in" || fail "the container $name could not be inspected"
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
if ! awk -f "$tmp/prog.awk" "$tmp/in" > "$tmp/out" 2>"$tmp/err"; then fail "could not build the container command: $(tr -d '\r' < "$tmp/err" | tail -n 1 | cut -c1-200)"; fi
cmd=$(cat "$tmp/out")
case "$cmd" in 'docker run -d'*) ;; *) fail 'could not build the container command' ;; esac
rest=${cmd#docker run -d}

BACKUP="$name-bosun-old"
if $D inspect --type container --format '{{.Id}}' "$BACKUP" >/dev/null 2>&1; then
  fail "a container named $BACKUP exists (left over from an earlier update); remove it first"
fi
why=''
health_ok() { # $1 = new container id
  deadline=$(( $(date +%s) + ht ))
  sleep "$POLL"
  while :; do
    st=$($D inspect --type container --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null)
    running=${st%% *}; health=${st#* }
    case "$running" in
      true) ;;
      *) why='the new container is not running'; return 1 ;;
    esac
    case "$health" in
      none|healthy) return 0 ;;
      unhealthy) why='the new container is unhealthy'; return 1 ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || { why="the new container did not become healthy within ${ht}s"; return 1; }
    sleep "$POLL"
  done
}
NEWID=''
rollback() { # $1 = reason
  [ -z "$NEWID" ] || $D rm -f "$NEWID" >/dev/null 2>&1
  if ! $D rename "$BACKUP" "$name" >/dev/null 2>"$errf"; then
    fail "rolled back: $1; and the old container could not be renamed back (it is still there as $BACKUP): $(lastline)"
  fi
  if [ "$wasrun" = true ]; then $D start "$name" >/dev/null 2>&1; fi
  fail "rolled back: $1"
}

echo 'PROGRESS 3/6'; echo "[step] Renaming $name to $BACKUP"
$D rename "$name" "$BACKUP" >/dev/null 2>"$errf" || fail "the container could not be renamed: $(lastline)"
echo 'PROGRESS 4/6'; echo "[step] Creating the new container $name"
NEWID=$(sh -c "$D create$rest" 2>"$errf") || { NEWID=''; rollback "creating the new container failed: $(lastline)"; }
NEWID=$(printf '%s\n' "$NEWID" | tail -n 1)
case "$NEWID" in ''|*[!0-9a-zA-Z:]*) NEWID=''; rollback 'docker create gave an unexpected answer' ;; esac
echo 'PROGRESS 5/6'; echo '[step] Starting the new container and waiting for it to be healthy'
if [ "$wasrun" = true ]; then
  $D stop "$BACKUP" >/dev/null 2>"$errf" || rollback "the old container could not be stopped: $(lastline)"
fi
$D start "$NEWID" >/dev/null 2>"$errf" || rollback "the new container could not be started: $(lastline)"
if ! health_ok "$NEWID"; then rollback "$why"; fi
echo '[step] Removing the old container (the previous image is kept)'
if $D rm -f "$BACKUP" >/dev/null 2>"$errf"; then
  echo 'PROGRESS 6/6'; echo "DONE updated $name"
else
  echo 'PROGRESS 6/6'; echo "DONE updated $name (the old container could not be removed and remains as $BACKUP: $(lastline))"
fi
exit 0
