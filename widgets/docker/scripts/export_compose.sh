#!/bin/sh
# Docker (Linux), dataset: one container as a compose file, {"text":"services:\n  name:\n    image: ..."}: one service named after the
# container with its settings (the ones inspect.sh knows, plus what an edit preserves where compose has a key): image, container_name,
# restart, hostname, user, working_dir, entrypoint, command, ports, volumes (named volumes also under a top-level `volumes:`, with
# `external: true` when the volume exists on the host), networks (top-level `networks:`, `external: true` when the network exists),
# environment, labels, tmpfs, mem_limit, cpus, dns, extra_hosts, logging, stop_signal, stop_grace_period, tty, stdin_open, init,
# read_only, healthcheck, privileged, pid, ipc, cap_add, cap_drop, devices, security_opt, sysctls, ulimits, shm_size and more. Every
# value is a double-quoted YAML string with `$` doubled (compose would otherwise expand it), so what the container holds comes back
# unchanged. Secrets in the environment are NOT removed (the person exports their own container). What compose cannot carry is listed in
# a `# Not exported:` comment at the top. Nothing is ever run. A failure prints `ERROR: message` (exit 0). Parameter: name.
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

# The program: the reader above and the writer of the compose file below (awk, POSIX; the data only ever reaches it as input lines).
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
BEGIN { for (i = 1; i < 32; i++) cc[sprintf("%c", i)] = sprintf("\\x%02x", i) }
# a double-quoted YAML scalar; `$` is doubled because compose interpolates variables
function yq(s,   o, i, c, n) {
  o = "\""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c == "$") o = o "$$"
    else if (c == "\n") o = o "\\n"; else if (c == "\t") o = o "\\t"; else if (c == "\r") o = o "\\r"
    else if (c in cc) o = o cc[c]
    else o = o c
  }
  return o "\""
}
function ykey(s) { if (s ~ /^[A-Za-z_][A-Za-z0-9_.-]*$/ && tolower(s) !~ /^(true|false|yes|no|on|off|null|y|n)$/) return s; return yq(s) }
function flow(a, n,   i, s) { s = "["; for (i = 1; i <= n; i++) s = s (i > 1 ? ", " : "") yq(a[i]); return s "]" }
function pr(s) { body = body s "\n" }
function list(key, a, n,   i) { if (n < 1) return; pr("    " key ":"); for (i = 1; i <= n; i++) pr("      - " yq(a[i])) }
END {
  derive()
  body = ""
  pr("services:")
  pr("  " ykey(cname) ":")
  pr("    image: " yq(image))
  pr("    container_name: " yq(cname))
  if (restart != "") pr("    restart: " yq(restart))
  if (out_host != "") pr("    hostname: " yq(out_host))
  if (out_user != "") pr("    user: " yq(out_user))
  if (out_wd != "") pr("    working_dir: " yq(out_wd))
  if (out_ep) pr("    entrypoint: " flow(ep, nep))
  if (out_cmd && ncmd > 0) pr("    command: " flow(cmd, ncmd))
  # ports
  if (np > 0) { pr("    ports:"); for (i = 1; i <= np; i++) pr("      - " yq(pubport(i))) }
  # volumes (named ones are declared at the top level)
  nv = 0
  for (i = 1; i <= nm; i++) {
    if (mtype[i] != "bind" && mtype[i] != "volume") continue
    if (mskip[i]) continue
    if (manon[i]) v = mdst[i]
    else if (mtype[i] == "bind") { v = msrc[i] ":" mdst[i]; if (mrw[i] == "false") v = v ":ro" }
    else {
      v = mname[i] ":" mdst[i]; if (mrw[i] == "false") v = v ":ro"
      if (!(mname[i] in vseen)) { vseen[mname[i]] = 1; vol[++nvol] = mname[i] }
    }
    vl[++nv] = v
  }
  list("volumes", vl, nv)
  list("tmpfs", tm, ntm)
  list("environment", env, ne)
  list("labels", lab, nlab)
  # networks
  if (netmode == "host" || netmode == "none" || netmode ~ /^container:/) pr("    network_mode: " yq(netmode))
  else {
    nn = 0
    if (netmode != "bridge") net[++nn] = netmode
    for (i = 1; i <= nnet; i++) if (netn[i] != "bridge" && netn[i] != "host" && netn[i] != "none" && netn[i] != netmode) net[++nn] = netn[i]
    attr = 0
    for (k = 1; k <= nn; k++) {
      n = net[k]
      if (n in ip4 || n in ip6) attr = 1
      for (i = 1; i <= nal; i++) if (alnet[i] == n && alname[i] != shortid && alname[i] != cname) attr = 1
    }
    if (nn > 0) {
      pr("    networks:")
      for (k = 1; k <= nn; k++) {
        n = net[k]
        if (!attr) { pr("      - " ykey(n)); continue }
        na = 0
        for (i = 1; i <= nal; i++) if (alnet[i] == n && alname[i] != shortid && alname[i] != cname) na++
        if (!na && !(n in ip4) && !(n in ip6)) { pr("      " ykey(n) ": {}"); continue }
        pr("      " ykey(n) ":")
        if (na) { pr("        aliases:"); for (i = 1; i <= nal; i++) if (alnet[i] == n && alname[i] != shortid && alname[i] != cname) pr("          - " yq(alname[i])) }
        if (n in ip4) pr("        ipv4_address: " yq(ip4[n]))
        if (n in ip6) pr("        ipv6_address: " yq(ip6[n]))
      }
    }
  }
  if (memory != "") pr("    mem_limit: " yq(memory))
  if (cpus != "") pr("    cpus: " cpus)
  if (isint(memres) && memres + 0 > 0) pr("    mem_reservation: " yq(memres "b"))
  if (isint(cpushares) && cpushares + 0 > 0) pr("    cpu_shares: " cpushares)
  if (isint(pidslim) && pidslim + 0 > 0) pr("    pids_limit: " pidslim)
  if (cpuset != "") pr("    cpuset: " yq(cpuset))
  if (isint(shm) && shm + 0 > 0 && shm + 0 != 67108864) pr("    shm_size: " yq(shm "b"))
  if (oom != "" && oom != "0" && oom ~ /^-?[0-9]+$/) pr("    oom_score_adj: " oom)
  if (nul > 0) { pr("    ulimits:"); for (i = 1; i <= nul; i++) { pr("      " ykey(ulname[i]) ":"); pr("        soft: " ulsoft[i]); pr("        hard: " ulhard[i]) } }
  list("group_add", grp, ngrp)
  list("dns", dns, ndns)
  list("dns_search", dnss, ndnss)
  list("dns_opt", dnso, ndnso)
  list("extra_hosts", xh, nxh)
  if (logdriver != "" || nlo > 0) {
    pr("    logging:")
    if (logdriver != "") pr("      driver: " yq(logdriver))
    if (nlo > 0) {
      pr("      options:")
      for (i = 1; i <= nlo; i++) { k = lo[i]; v = ""; p = index(k, "="); if (p > 0) { v = substr(k, p + 1); k = substr(k, 1, p - 1) } pr("        " yq(k) ": " yq(v)) }
    }
  }
  if (out_stopsig != "") pr("    stop_signal: " yq(out_stopsig))
  if (out_stopto != "") pr("    stop_grace_period: " yq(out_stopto "s"))
  if (tty == "true") pr("    tty: true")
  if (open == "true") pr("    stdin_open: true")
  if (init == "true") pr("    init: true")
  if (ro == "true") pr("    read_only: true")
  if (out_health) {
    pr("    healthcheck:")
    if (hnone) pr("      disable: true")
    else {
      pr("      test: " flowtest())
      if (hint_o != "") pr("      interval: " yq(hint_o))
      if (hto_o != "") pr("      timeout: " yq(hto_o))
      if (hret_o != "") pr("      retries: " hret_o)
      if (hstart_o != "") pr("      start_period: " yq(hstart_o))
    }
  }
  if (priv == "true") pr("    privileged: true")
  if (pidm == "host") pr("    pid: \"host\"")
  if (ipcm == "host") pr("    ipc: \"host\"")
  if (uts == "host") pr("    uts: \"host\"")
  if (userns == "host") pr("    userns_mode: \"host\"")
  list("cap_add", cadd, ncadd)
  list("cap_drop", cdrop, ncdrop)
  list("devices", dev, ndev)
  list("security_opt", sec, nsec)
  list("sysctls", sys, nsys)
  list("device_cgroup_rules", dcr, ndcr)
  if (cgp != "") pr("    cgroup_parent: " yq(cgp))
  if (rt != "" && rt != "runc") pr("    runtime: " yq(rt))
  if (nsop > 0) {
    pr("    storage_opt:")
    for (i = 1; i <= nsop; i++) { k = sop[i]; v = ""; p = index(k, "="); if (p > 0) { v = substr(k, p + 1); k = substr(k, 1, p - 1) } pr("      " yq(k) ": " yq(v)) }
  }
  if (gpus != "") {
    pr("    deploy:"); pr("      resources:"); pr("        reservations:"); pr("          devices:")
    pr("            - driver: \"nvidia\""); pr("              count: " (gpus == "all" ? "\"all\"" : gpus)); pr("              capabilities: [\"gpu\"]")
  }
  # top-level volumes and networks
  if (nvol > 0) { pr("volumes:"); for (i = 1; i <= nvol; i++) { if (vol[i] in vexists) { pr("  " ykey(vol[i]) ":"); pr("    external: true") } else pr("  " ykey(vol[i]) ": {}") } }
  if (nn > 0) { pr("networks:"); for (k = 1; k <= nn; k++) { if (net[k] in nexists) { pr("  " ykey(net[k]) ":"); pr("    external: true") } else pr("  " ykey(net[k]) ": {}") } }
  if (unm != "") printf "# Not exported: %s\n", unm
  printf "%s", body
}
function flowtest(   i, s) { s = "[" yq(hkind); for (i = 1; i <= nha; i++) s = s ", " yq(ha[i]); return s "]" }
BOSUN_AWK_END

if ! awk -f "$tmp/prog.awk" "$tmp/in" > "$tmp/out" 2>"$tmp/err"; then fail "could not build the compose file: $(tr -d '\r' < "$tmp/err" | tail -n 1 | cut -c1-200)"; fi
# The text as one JSON string (control characters become \u00XX, nothing is dropped).
awk 'BEGIN { for (i = 1; i < 32; i++) cc[sprintf("%c", i)] = sprintf("\\u%04x", i); cc["\t"] = "\\t"; cc["\r"] = "\\r"; printf "{\"text\":\"" }
  { n = length($0); o = ""; for (i = 1; i <= n; i++) { c = substr($0, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c in cc) o = o cc[c]; else o = o c } printf "%s\\n", o }
  END { print "\"}" }' "$tmp/out"
exit 0
