#!/bin/sh
# Docker (Linux), dataset: one container as a `docker run -d` command, {"text":"docker run -d \\\n  --name web \\\n  ... \\\n  image"}: one
# option per line, joined with \ line continuations, every value quoted for a POSIX shell. The settings are the ones inspect.sh knows
# (what differs from the image's own defaults), plus the ones an edit preserves where a docker run flag exists (ulimit, shm-size,
# group-add, device-cgroup-rule, oom-score-adj, cgroup-parent, runtime, storage-opt, a static --ip). Secrets in the environment are NOT
# removed (the person exports their own container). What no flag can carry is listed in `# Not exported:` comment lines at the end.
# Nothing is ever run: the command is only text. A failure prints `ERROR: message` (exit 0). Parameter: name.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid container name' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid container name'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || fail 'Docker is not available to this account'
# >>> export collector (the same text in export_run.sh and export_compose.sh; a test compares them)
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

tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
collect "$name" "$tmp/in" || fail "container $name not found or could not be inspected"

# The program: the reader above and the writer of the command below (awk, POSIX; the data only ever reaches it as input lines).
cat > "$tmp/prog.awk" <<'BOSUN_AWK_END'
# >>> export reader (the same text in export_run.sh and export_compose.sh; a test compares them)
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
  if (tag == "ID") id = toknext()
  else if (tag == "NAME") cname = toknext()
  else if (tag == "IMAGE") image = toknext()
  else if (tag == "IMGID") imgid = rest
  else if (tag == "ENV") { v = toknext(); if (!(v in ienv)) env[++ne] = v }
  else if (tag == "CMDJ") cmdj = rest
  else if (tag == "EPJ") epj = rest
  else if (tag == "CMD") cmd[++ncmd] = toknext()
  else if (tag == "EP") ep[++nep] = toknext()
  else if (tag == "LABEL") { v = toknext(); if (v ~ /^com\.docker\.compose\./) ncomp++; else if (!(v in ilabel)) lab[++nlab] = v }
  else if (tag == "PORT") { np++; pip[np] = toknext(); php[np] = toknext(); pcp[np] = toknext() }
  else if (tag == "MNT") { nm++; mtype[nm] = toknext(); mname[nm] = toknext(); msrc[nm] = toknext(); mdst[nm] = toknext(); mrw[nm] = toknext() }
  else if (tag == "TMPFS") tm[++ntm] = toknext()
  else if (tag == "NETMODE") netmode = toknext()
  else if (tag == "NETN") netn[++nnet] = toknext()
  else if (tag == "ALIAS") { nal++; alnet[nal] = toknext(); alname[nal] = toknext() }
  else if (tag == "IP4") { k = toknext(); ip4[k] = toknext() }
  else if (tag == "IP6") { k = toknext(); ip6[k] = toknext() }
  else if (tag == "RP") rp = toknext()
  else if (tag == "RPN") rpn = rest
  else if (tag == "HOSTNAME") host = toknext()
  else if (tag == "USER") { userj = rest; user = toknext() }
  else if (tag == "WORKDIR") { wdj = rest; wd = toknext() }
  else if (tag == "MEM") mem = rest
  else if (tag == "NANO") nano = rest
  else if (tag == "DNS") dns[++ndns] = toknext()
  else if (tag == "EXTRAHOST") xh[++nxh] = toknext()
  else if (tag == "LOGT") logt = toknext()
  else if (tag == "LOGO") lo[++nlo] = toknext()
  else if (tag == "STOPSIG") { stopj = rest; stopsig = toknext() }
  else if (tag == "STOPTO") stopto = rest
  else if (tag == "TTY") tty = rest
  else if (tag == "OPEN") open = rest
  else if (tag == "INIT") init = rest
  else if (tag == "RO") ro = rest
  else if (tag == "HEALTHJ") healthj = rest
  else if (tag == "HKIND") hkind = toknext()
  else if (tag == "HARG") ha[++nha] = toknext()
  else if (tag == "HINT") hint = rest
  else if (tag == "HTO") hto = rest
  else if (tag == "HRET") hret = rest
  else if (tag == "HSTART") hstart = rest
  else if (tag == "PRIV") priv = rest
  else if (tag == "PIDM") pidm = toknext()
  else if (tag == "IPCM") ipcm = toknext()
  else if (tag == "CAPADD") cadd[++ncadd] = capname(toknext())
  else if (tag == "CAPDROP") cdrop[++ncdrop] = capname(toknext())
  else if (tag == "DEVICE") dev[++ndev] = toknext()
  else if (tag == "SECOPT") sec[++nsec] = toknext()
  else if (tag == "SYSCTL") sys[++nsys] = toknext()
  else if (tag == "GPU") gpu = rest
  else if (tag == "DCR") dcr[++ndcr] = toknext()
  else if (tag == "ULIM") { nul++; ulname[nul] = toknext(); ulsoft[nul] = toknext(); ulhard[nul] = toknext() }
  else if (tag == "GRP") grp[++ngrp] = toknext()
  else if (tag == "SOPT") sop[++nsop] = toknext()
  else if (tag == "SHM") shm = rest
  else if (tag == "OOM") oom = rest
  else if (tag == "CGP") cgp = toknext()
  else if (tag == "RT") rt = toknext()
  else if (tag == "LINK") links = links (links == "" ? "" : ", ") toknext()
  else if (tag == "VFROM") vfrom = vfrom (vfrom == "" ? "" : ", ") toknext()
  else if (tag == "CPUSET") cpuset = toknext()
  else if (tag == "DNSS") dnss[++ndnss] = toknext()
  else if (tag == "DNSO") dnso[++ndnso] = toknext()
  else if (tag == "CPUSHARES") cpushares = rest
  else if (tag == "PIDSLIM") pidslim = rest
  else if (tag == "MEMRES") memres = rest
  else if (tag == "UTS") uts = toknext()
  else if (tag == "USERNS") userns = toknext()
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
function add(s) { L[++nl] = s }
function opt(flag, v) { add(flag " " shq(v)) }
END {
  derive()
  add("--name " shq(cname))
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
    if (mskip[i]) continue
    if (manon[i]) { opt("-v", mdst[i]); continue }
    if (mtype[i] == "bind") v = msrc[i] ":" mdst[i]; else v = mname[i] ":" mdst[i]
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
  s = s " \\\n  " shq(image)
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
BOSUN_AWK_END

if ! awk -f "$tmp/prog.awk" "$tmp/in" > "$tmp/out" 2>"$tmp/err"; then fail "could not build the command: $(tr -d '\r' < "$tmp/err" | tail -n 1 | cut -c1-200)"; fi
# The text as one JSON string (control characters become \u00XX, nothing is dropped).
awk 'BEGIN { for (i = 1; i < 32; i++) cc[sprintf("%c", i)] = sprintf("\\u%04x", i); cc["\t"] = "\\t"; cc["\r"] = "\\r"; printf "{\"text\":\"" }
  { n = length($0); o = ""; for (i = 1; i <= n; i++) { c = substr($0, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c in cc) o = o cc[c]; else o = o c } printf "%s\\n", o }
  END { print "\"}" }' "$tmp/out"
exit 0
