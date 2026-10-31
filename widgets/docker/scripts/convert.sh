#!/bin/sh
# Docker (Linux), dataset: pasted text -> the settings of the container editor, {"fill":{<settings key>: "text" | ["text",...]},
# "errors":["Not converted: <flag and value> (<reason>)"],"notes":["..."]}. Parameter: input (text, at most 65536 characters and 2000 lines).
# The text is either a `docker run` / `docker container run` / `docker create` command (optionally after sudo; line continuations
# \ ^ and a closing backtick; single and double quotes; --flag=value; combined short flags) or a compose file (a line `services:`).
# NOTHING FROM THE TEXT IS EVER RUN OR EXPANDED: the command is split into words by awk (no eval, no shell parsing of the text), $(...)
# and backticks are refused, $VAR stays text (with a note). A compose file is only resolved by `docker compose config --no-interpolate`
# in a throw-away folder (variables are not expanded, so the environment of this host cannot leak into the result); env_file, include
# and extends are refused (they would read files of this host). The fill object only has keys of the settings blob (booleans as
# "true"/"false", repeated keys as arrays). A failure of this script prints `ERROR: message` (exit 0).
jerr() { # the whole answer for something that stops the conversion
  m=$(printf '%s' "$1" | tr '\n\t' '  ' | tr -d '[:cntrl:]' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-600)
  printf '{"fill":{},"errors":["%s"],"notes":[]}\n' "$m"; exit 0
}
input=$BOSUN_PARAM_input
case "$input" in *[![:space:]]*) ;; *) jerr 'Paste a docker run command or a compose file.' ;; esac
[ "${#input}" -le 65536 ] || jerr 'The text is too long (at most 65536 characters).'
tmp=$(mktemp -d) || { echo 'ERROR: cannot create a temporary folder'; exit 0; }
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$input" | tr -d '\r' > "$tmp/in"
[ "$(wc -l < "$tmp/in")" -le 2000 ] || jerr 'The text has too many lines (at most 2000).'
MODE=run; PROJ=''
if grep -q '^services[[:space:]]*:' "$tmp/in"; then
  MODE=compose
  bad=$(grep -E '^[[:space:]-]*(env_file|include|extends)[[:space:]]*:' "$tmp/in" | head -n 1 | sed 's/^[[:space:]-]*//' | cut -c1-60)
  [ -z "$bad" ] || jerr "Not converted: $bad (files of the host are not available here: put the variables and services in the file itself)"
  D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
  $D ps >/dev/null 2>&1 || jerr 'Docker is not available to this account, so a compose file cannot be converted.'
  $D compose version >/dev/null 2>&1 || jerr 'Docker Compose (the docker compose plugin) is not installed on this host, so a compose file cannot be converted.'
  mkdir "$tmp/c" || { echo 'ERROR: cannot create a temporary folder'; exit 0; }
  cp "$tmp/in" "$tmp/c/compose.yaml"
  PROJ=$(cd "$tmp/c" && pwd -P)
  if ! (cd "$tmp/c" && $D compose -p bosun-convert --project-directory "$PROJ" -f compose.yaml config --no-interpolate --format json > "$tmp/cfg" 2> "$tmp/cfgerr" < /dev/null); then
    jerr "Docker Compose could not read the file: $(tr -d '\r' < "$tmp/cfgerr" | sed "s#$PROJ/##g" | sed '/^$/d' | head -n 3 | tr '\n' ' ' | cut -c1-400)"
  fi
fi

cat > "$tmp/prog.awk" <<'BOSUN_AWK_END'
BEGIN {
  # -- the flags of docker run: def(names, kind v|b, key of the settings), bad(names, kind, reason), nt(names, kind, text for the notes)
  def("--name", "v", "name"); def("-p,--publish", "v", "port"); def("-v,--volume", "v", "volume"); def("--mount", "v", "mount")
  def("-e,--env", "v", "env"); def("-l,--label", "v", "label"); def("--network,--net", "v", "network")
  def("--network-alias,--net-alias", "v", "network_alias"); def("--restart", "v", "restart"); def("-h,--hostname", "v", "hostname")
  def("-u,--user", "v", "user"); def("-w,--workdir", "v", "workdir"); def("-m,--memory", "v", "memory"); def("--cpus", "v", "cpus")
  def("--dns", "v", "dns"); def("--add-host", "v", "add_host"); def("--log-driver", "v", "log_driver"); def("--log-opt", "v", "log_opt")
  def("--stop-signal", "v", "stop_signal"); def("--stop-timeout", "v", "stop_timeout"); def("--health-cmd", "v", "health_cmd")
  def("--health-interval", "v", "health_interval"); def("--health-timeout", "v", "health_timeout"); def("--health-retries", "v", "health_retries")
  def("--pid", "v", "pid"); def("--ipc", "v", "ipc"); def("--cap-add", "v", "cap_add"); def("--cap-drop", "v", "cap_drop")
  def("--device", "v", "device"); def("--security-opt", "v", "security_opt"); def("--sysctl", "v", "sysctl"); def("--tmpfs", "v", "tmpfs")
  def("--gpus", "v", "gpus"); def("--entrypoint", "v", "entrypoint")
  def("-t,--tty", "b", "tty"); def("-i,--interactive", "b", "interactive"); def("--init", "b", "init"); def("--read-only", "b", "read_only")
  def("--privileged", "b", "privileged"); def("-d,--detach", "b", "detach")
  nt("--rm", "b", "the container is created normally and is not removed when it stops")
  nt("--pull", "v", "a missing image is pulled, an existing one is used as it is")
  nt("--expose", "v", "it only documents a port, nothing is published")
  nt("--sig-proxy,--disable-content-trust,-q,--quiet", "b", "it does not change the container")
  bad("--env-file", "v", "the file is not available here: put the variables in -e options")
  bad("--label-file", "v", "the file is not available here: put the labels in -l options")
  bad("-P,--publish-all", "b", "random published ports are not supported: use -p")
  bad("--no-healthcheck", "b", "disabling a health check is not supported by the editor")
  bad("--oom-kill-disable,--use-api-socket", "b", "not supported by the editor")
  bad("--health-start-period", "v", "the health check start period is not supported by the editor")
  bad("--platform", "v", "choosing a platform is not supported by the editor")
  bad("--annotation,-a,--attach,--blkio-weight,--blkio-weight-device,--cgroup-parent,--cgroupns,--cidfile,--cpu-count,--cpu-percent,--cpu-period,--cpu-quota,--cpu-rt-period,--cpu-rt-runtime,-c,--cpu-shares,--cpuset-cpus,--cpuset-mems,--detach-keys,--device-cgroup-rule,--device-read-bps,--device-read-iops,--device-write-bps,--device-write-iops,--dns-option,--dns-opt,--dns-search,--domainname,--group-add,--health-start-interval,--io-maxbandwidth,--io-maxiops,--ip,--ip6,--isolation,--kernel-memory,--link,--link-local-ip,--mac-address,--memory-reservation,--memory-swap,--memory-swappiness,--oom-score-adj,--pids-limit,--runtime,--shm-size,--storage-opt,--ulimit,--userns,--uts,--volume-driver,--volumes-from", "v", "not supported by the editor")
  split("name image cmd entrypoint env port volume tmpfs label network network_alias restart hostname user workdir memory cpus dns add_host log_driver log_opt stop_signal stop_timeout tty interactive init read_only health_cmd health_interval health_timeout health_retries privileged pid ipc cap_add cap_drop device security_opt sysctl gpus", KEYS, " ")
  NKEYS = 41
  for (i = 1; i <= NKEYS; i++) ISLIST[KEYS[i]] = 0
  split("cmd entrypoint env port volume tmpfs label network_alias dns add_host log_opt cap_add cap_drop device security_opt sysctl", LK, " ")
  for (i = 1; i <= 16; i++) ISLIST[LK[i]] = 1
  for (i = 1; i < 32; i++) CC[sprintf("%c", i)] = sprintf("\\u%04x", i)
  CC["\t"] = "\\t"; CC["\r"] = "\\r"; CC["\n"] = "\\n"
  TEXT = ""
}
function def(names, kind, id,   a, n, i) { n = split(names, a, ","); for (i = 1; i <= n; i++) { KIND[a[i]] = kind; ID[a[i]] = id } }
function bad(names, kind, why,   a, n, i) { n = split(names, a, ","); for (i = 1; i <= n; i++) { KIND[a[i]] = kind; ID[a[i]] = "bad"; WHY[a[i]] = why } }
function nt(names, kind, text,   a, n, i) { n = split(names, a, ","); for (i = 1; i <= n; i++) { KIND[a[i]] = kind; ID[a[i]] = "note"; WHY[a[i]] = text } }

# ---------- results ----------
function err(s) { NERR++; ERRS[NERR] = s }
function note(s,   i) { for (i = 1; i <= NNOTE; i++) if (NOTES[i] == s) return; NNOTE++; NOTES[NNOTE] = s }
function notconv(shown, why) { err("Not converted: " shown " (" why ")") }
function setv(k, v) { FN[k] = 1; FV[k, 1] = v }
function addl(k, v) { FN[k]++; FV[k, FN[k]] = v }
function jesc(s,   o, i, c, n) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c in CC) o = o CC[c]; else o = o c }
  return o
}
function emit(   i, j, k, s, first) {
  s = "{\"fill\":{"; first = 1
  for (i = 1; i <= NKEYS; i++) {
    k = KEYS[i]
    if (FN[k] < 1) continue
    if (!first) s = s ","
    first = 0
    if (ISLIST[k]) { s = s "\"" k "\":["; for (j = 1; j <= FN[k]; j++) s = s (j > 1 ? "," : "") "\"" jesc(FV[k, j]) "\""; s = s "]" }
    else s = s "\"" k "\":\"" jesc(FV[k, 1]) "\""
  }
  s = s "},\"errors\":["
  for (i = 1; i <= NERR; i++) s = s (i > 1 ? "," : "") "\"" jesc(ERRS[i]) "\""
  s = s "],\"notes\":["
  for (i = 1; i <= NNOTE; i++) s = s (i > 1 ? "," : "") "\"" jesc(NOTES[i]) "\""
  print s "]}"
}

# ---------- small helpers ----------
function shq(s,   o, i, c, n) {
  if (s == "") return "''"
  if (s ~ /^[A-Za-z0-9_@%+=:,.\/-]+$/) return s
  o = "'"; n = length(s)
  for (i = 1; i <= n; i++) { c = substr(s, i, 1); if (c == "'") o = o "'\\''"; else o = o c }
  return o "'"
}
function shown(flag, val, hasval) { return hasval ? flag " " shq(val) : flag }
function isnum(s) { return s ~ /^[0-9]+$/ && length(s) <= 9 }
function validname(s) { return s ~ /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/ && length(s) <= 128 }
function rng(s) { return s ~ /^[0-9]+(-[0-9]+)?$/ }
function isip4(s) { return s ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ }
function chkport(p,   a, n, rest) {
  sub(/\/(tcp|udp|sctp)$/, "", p)
  if (p ~ /^\[/) {
    if (p !~ /^\[[0-9a-fA-F:]+\]:/) return 0
    rest = substr(p, index(p, "]:") + 2); n = split(rest, a, ":")
    return n == 2 && (a[1] == "" || rng(a[1])) && rng(a[2])
  }
  n = split(p, a, ":")
  if (n == 1) return rng(a[1])
  if (n == 2) return rng(a[1]) && rng(a[2])
  if (n == 3) return isip4(a[1]) && (a[2] == "" || rng(a[2])) && rng(a[3])
  return 0
}
# a duration as Go writes it (1m30s, 90s, 500ms, 1h) -> one unit the editor accepts (30s, 2m, 1h, 500ms), or "" when it is not one
function todur(s,   ms, num, u, t) {
  ms = 0; t = s
  if (t == "" || t == "0") return ""
  while (t != "") {
    if (!match(t, /^[0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h)/)) return ""
    num = substr(t, 1, RLENGTH); t = substr(t, RLENGTH + 1)
    if (num ~ /ms$/) { u = 1; sub(/ms$/, "", num) }
    else if (num ~ /ns$/) { u = 0.000001; sub(/ns$/, "", num) }
    else if (num ~ /us$/) { u = 0.001; sub(/us$/, "", num) }
    else if (num ~ /s$/) { u = 1000; sub(/s$/, "", num) }
    else if (num ~ /m$/) { u = 60000; sub(/m$/, "", num) }
    else { u = 3600000; sub(/h$/, "", num) }
    ms += num * u
  }
  if (ms <= 0) return ""
  if (ms != int(ms)) return ""
  if (ms % 3600000 == 0) return (ms / 3600000) "h"
  if (ms % 60000 == 0) return (ms / 60000) "m"
  if (ms % 1000 == 0) return (ms / 1000) "s"
  return ms "ms"
}
function todursec(s,   d, n) { d = todur(s); if (d == "") return ""; n = d; sub(/[a-z]+$/, "", n); if (d ~ /ms$/) return int(n / 1000) + 1; if (d ~ /h$/) return n * 3600; if (d ~ /m$/) return n * 60; return n }
# memory: docker run -m takes bytes for a plain number; the editor takes MB, so a plain number becomes bytes with a b
function tomem(s) { if (s ~ /^[0-9]+$/) return s "b"; return s }

# ---------- the shell-like tokenizer ----------
# Splits s into TK[1..TN] without ever running anything: single and double quotes, backslash, line continuations (\ or ^ or a backtick at
# the end of a line), `--flag=value` stays one token (the caller splits it), # starts a comment. strict = a docker run command: $(...) and
# backticks are refused (the return value names them) and an unquoted ; | & < > ends the command (OPTEXT holds the rest).
# $VAR text is kept as it is (VARSEEN is set). EXTRA holds text that follows the first command line.
function tokenize(s, strict,   i, n, c, c2, cur, have, q, rest) {
  n = length(s); i = 1; TN = 0; have = 0; cur = ""; q = 0; OPTEXT = ""; EXTRA = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (q == 1) { if (c == "'") q = 0; else cur = cur c; i++; continue }
    if (q == 2) {
      if (c == "\"") { q = 0; i++; continue }
      if (c == "\\") {
        c2 = substr(s, i + 1, 1)
        if (c2 == "\n") { i += 2; continue }
        if (c2 == "\"" || c2 == "\\" || c2 == "$" || c2 == "`") { cur = cur c2; i += 2; continue }
        cur = cur c; i++; continue
      }
      if (c == "$") { if (substr(s, i + 1, 1) == "(" && strict) return "$(...)"; if (substr(s, i + 1, 1) ~ /[A-Za-z_{0-9]/) VARSEEN = 1 }
      if (c == "`" && strict) return "backticks"
      cur = cur c; i++; continue
    }
    if (c == "\\") {
      c2 = substr(s, i + 1, 1)
      if (c2 == "\n") { i += 2; continue }
      if (c2 == "") { i++; continue }
      cur = cur c2; have = 1; i += 2; continue
    }
    if (c == "^" && substr(s, i + 1, 1) == "\n") { i += 2; continue }
    if (c == "`") {
      if (substr(s, i + 1, 1) == "\n") { i += 2; continue }
      if (strict) return "backticks"
      cur = cur c; have = 1; i++; continue
    }
    if (c == "'") { q = 1; have = 1; i++; continue }
    if (c == "\"") { q = 2; have = 1; i++; continue }
    if (c == "$") {
      if (substr(s, i + 1, 1) == "(" && strict) return "$(...)"
      if (substr(s, i + 1, 1) ~ /[A-Za-z_{0-9]/) VARSEEN = 1
      cur = cur c; have = 1; i++; continue
    }
    if (c == " " || c == "\t") { if (have) { TK[++TN] = cur; cur = ""; have = 0 } i++; continue }
    if (c == "\n") {
      if (have) { TK[++TN] = cur; cur = ""; have = 0 }
      i++
      if (strict && TN > 0) {
        rest = substr(s, i)
        sub(/^([ \t\n]|#[^\n]*)*/, "", rest)
        if (rest != "") { EXTRA = substr(rest, 1, 60); sub(/\n.*/, "", EXTRA) }
        return ""
      }
      continue
    }
    if (c == "#" && !have) { while (i <= n && substr(s, i, 1) != "\n") i++; continue }
    if (strict && (c == ";" || c == "|" || c == "&" || c == "<" || c == ">")) {
      if (have) { TK[++TN] = cur; cur = ""; have = 0 }
      OPTEXT = substr(s, i, 40); sub(/\n.*/, "", OPTEXT)
      return ""
    }
    cur = cur c; have = 1; i++
  }
  if (q) return "unterminated"
  if (have) TK[++TN] = cur
  return ""
}

# ---------- docker run ----------
function apply(id, val, flag, hasval,   sh, a, n, i, src, dst, opts, t, k, v, p, ro, ty, nopt, unk) {
  sh = shown(flag, val, hasval)
  if (id == "detach") return
  if (id == "tty" || id == "interactive" || id == "init" || id == "read_only" || id == "privileged") {
    if (!hasval || val == "true") setv(id, "true"); else if (val == "false") setv(id, "false"); else notconv(sh, "use true or false")
    return
  }
  if (id == "name") { if (index(val, "$") == 0 && !validname(val)) { notconv(sh, "a name can use letters, digits, _ . - and starts with a letter or digit"); return } setv("name", val); return }
  if (id == "port") { if (index(val, "$") == 0 && !chkport(val)) { notconv(sh, "not a valid port mapping"); return } addl("port", val); return }
  if (id == "env") {
    if (val !~ /=/) { notconv(sh, "takes the value from the environment of the person who runs docker: write KEY=value"); return }
    addl("env", val); return
  }
  if (id == "label") { if (val !~ /=/) val = val "="; addl("label", val); return }
  if (id == "network") {
    if (val ~ /^container:/ || val ~ /^ns:/) { notconv(sh, "sharing the network of another container is not supported"); return }
    if (val == "default") val = "bridge"
    if (index(val, "$") == 0 && val != "bridge" && val != "host" && val != "none" && !validname(val)) { notconv(sh, "not a valid network name"); return }
    setv("network", val); return
  }
  if (id == "network_alias") { addl("network_alias", val); return }
  if (id == "restart") {
    if (index(val, "$") == 0 && val !~ /^(no|always|unless-stopped|on-failure(:[0-9]+)?)$/) { notconv(sh, "use no, always, unless-stopped, on-failure or on-failure:N"); return }
    setv("restart", val); return
  }
  if (id == "hostname" || id == "user" || id == "workdir" || id == "stop_signal" || id == "health_cmd") { setv(id, val); return }
  if (id == "memory") {
    if (index(val, "$") == 0 && val !~ /^[0-9]+[bkmgBKMG]?$/) { notconv(sh, "use a number with an optional unit, e.g. 512m or 2g"); return }
    setv("memory", index(val, "$") ? val : tomem(val)); return
  }
  if (id == "cpus") { if (index(val, "$") == 0 && val !~ /^[0-9]+(\.[0-9]+)?$/) { notconv(sh, "use a decimal number, e.g. 1.5"); return } setv("cpus", val); return }
  if (id == "dns") { addl("dns", val); return }
  if (id == "add_host") { t = val; if (t ~ /=/ && t !~ /:/) sub(/=/, ":", t); if (index(val, "$") == 0 && t !~ /^[^:]+:.+$/) { notconv(sh, "use host:ip"); return } addl("add_host", t); return }
  if (id == "log_driver") { setv("log_driver", val); return }
  if (id == "log_opt") { if (val !~ /=/) { notconv(sh, "use key=value"); return } addl("log_opt", val); return }
  if (id == "stop_timeout") { if (index(val, "$") == 0 && !isnum(val)) { notconv(sh, "use a number of seconds"); return } setv("stop_timeout", val); return }
  if (id == "health_interval" || id == "health_timeout") {
    if (index(val, "$")) { setv(id, val); return }
    t = todur(val); if (t == "") { notconv(sh, "use a duration such as 30s or 1m"); return }
    setv(id, t); return
  }
  if (id == "health_retries") { if (index(val, "$") == 0 && !isnum(val)) { notconv(sh, "use a number"); return } setv("health_retries", val); return }
  if (id == "pid" || id == "ipc") {
    if (val == "") return
    if (val != "host") { notconv(sh, "only host is supported"); return }
    setv(id, "host"); return
  }
  if (id == "cap_add" || id == "cap_drop") { addl(id, val); return }
  if (id == "device" || id == "security_opt" || id == "sysctl") { if (id == "sysctl" && val !~ /=/) { notconv(sh, "use key=value"); return } addl(id, val); return }
  if (id == "tmpfs") { addl("tmpfs", val); return }
  if (id == "gpus") {
    if (val == "all" || isnum(val)) { setv("gpus", val); return }
    notconv(sh, "only all or a number of GPUs is supported"); return
  }
  if (id == "entrypoint") { addl("entrypoint", val); return }
  if (id == "volume") {
    n = split(val, a, ":")
    if (n == 1) { notconv(sh, "anonymous volumes are not supported: give the volume a name (name:/path)"); return }
    if (n > 3) { notconv(sh, "not a valid volume (source:target[:ro])"); return }
    src = a[1]; dst = a[2]; opts = (n == 3) ? a[3] : ""
    if (index(val, "$") == 0) {
      if (dst !~ /^\//) { notconv(sh, "the target must be an absolute path in the container"); return }
      if (src ~ /^(\.|~)/) { notconv(sh, "a relative host path is not supported: use an absolute path or a volume name"); return }
      if (src !~ /^\// && !validname(src)) { notconv(sh, "the source must be a volume name or an absolute host path"); return }
    }
    ro = 0; nopt = split(opts, a, ",")
    for (i = 1; i <= nopt; i++) {
      t = a[i]
      if (t == "ro") ro = 1
      else if (t == "rw" || t == "") ;
      else if (t == "z" || t == "Z" || t == "nocopy" || t == "cached" || t == "delegated" || t == "consistent") note("The volume option " t " of " sh " was dropped (it does not change what the editor sets)")
      else notconv(sh, "the volume option " t " is not supported")
    }
    addl("volume", src ":" dst (ro ? ":ro" : "")); return
  }
  if (id == "mount") {
    nopt = split(val, a, ","); ty = "volume"; src = ""; dst = ""; ro = 0; unk = ""; opts = ""
    for (i = 1; i <= nopt; i++) {
      t = a[i]; k = t; v = ""
      p = index(t, "="); if (p > 0) { k = substr(t, 1, p - 1); v = substr(t, p + 1) }
      if (k == "type") ty = v
      else if (k == "source" || k == "src") src = v
      else if (k == "target" || k == "destination" || k == "dst") dst = v
      else if (k == "readonly" || k == "ro") ro = (p == 0 || v == "true" || v == "1")
      else if (k == "tmpfs-size") opts = opts (opts == "" ? "" : ",") "size=" v
      else if (k == "tmpfs-mode") opts = opts (opts == "" ? "" : ",") "mode=" v
      else if (k == "consistency" || k == "volume-nocopy") note("The mount option " k " of " sh " was dropped")
      else if (k != "") unk = unk (unk == "" ? "" : ", ") k
    }
    if (unk != "") { notconv(sh, "the mount option " unk " is not supported"); return }
    if (ty != "bind" && ty != "volume" && ty != "tmpfs") { notconv(sh, "the mount type " ty " is not supported"); return }
    if (dst == "") { notconv(sh, "the mount has no target"); return }
    if (ty == "tmpfs") { addl("tmpfs", dst (opts != "" ? ":" opts : "")); return }
    if (src == "") { notconv(sh, "anonymous volumes are not supported: give the volume a name"); return }
    if (ty == "bind" && src !~ /^\// && index(src, "$") == 0) { notconv(sh, "a bind mount needs an absolute host path"); return }
    addl("volume", src ":" dst (ro ? ":ro" : "")); return
  }
}
function convert_run(   i, t, flag, val, hasval, p, kind, id, j, fc, rest, ncand, stopopts, image, c, k) {
  i = 1
  if (TK[i] == "$") i++
  if (TK[i] == "sudo") { i++; while (i <= TN && TK[i] ~ /^-/) i++ }
  if (TK[i] != "docker") { err("This is not a docker run command (it should start with docker run)."); return }
  i++
  if (TK[i] == "container") i++
  if (TK[i] != "run" && TK[i] != "create") { err("This is not a docker run command (it should start with docker run or docker create)."); return }
  i++
  while (i <= TN) {
    t = TK[i]
    if (t == "--") { i++; break }
    if (substr(t, 1, 1) != "-" || t == "-") break
    i++
    if (substr(t, 1, 2) == "--") {
      flag = t; val = ""; hasval = 0
      p = index(t, "=")
      if (p > 0) { flag = substr(t, 1, p - 1); val = substr(t, p + 1); hasval = 1 }
      if (!(flag in KIND)) {
        # an unknown flag: its value is the next word when more words follow after that one (the image must remain)
        if (!hasval && i < TN && substr(TK[i], 1, 1) != "-") { ncand = 0; for (j = i + 1; j <= TN; j++) if (substr(TK[j], 1, 1) != "-") ncand++; if (ncand > 0) { val = TK[i]; hasval = 1; i++ } }
        notconv(shown(flag, val, hasval), "unknown flag, not supported by the editor")
        continue
      }
      kind = KIND[flag]; id = ID[flag]
      if (kind == "v" && !hasval) { if (i > TN) { notconv(flag, "the value is missing"); continue } val = TK[i]; i++; hasval = 1 }
      if (kind == "b" && hasval && val != "true" && val != "false" && id != "bad" && id != "note") { notconv(shown(flag, val, 1), "use true or false"); continue }
      if (id == "bad") { notconv(shown(flag, val, hasval), WHY[flag]); continue }
      if (id == "note") { note(flag " was ignored: " WHY[flag]); continue }
      apply(id, val, flag, hasval)
      continue
    }
    # short flags, possibly combined (-dit) and with an attached value (-p8080:80)
    for (j = 2; j <= length(t); j++) {
      fc = substr(t, j, 1); flag = "-" fc
      if (!(flag in KIND)) { notconv(flag, "unknown flag, not supported by the editor"); continue }
      kind = KIND[flag]; id = ID[flag]
      if (kind == "b") {
        if (id == "bad") notconv(flag, WHY[flag]); else if (id == "note") note(flag " was ignored: " WHY[flag]); else apply(id, "", flag, 0)
        continue
      }
      rest = substr(t, j + 1)
      if (rest != "") { val = rest; if (substr(val, 1, 1) == "=") val = substr(val, 2) }
      else { if (i > TN) { notconv(flag, "the value is missing"); break } val = TK[i]; i++ }
      if (id == "bad") notconv(shown(flag, val, 1), WHY[flag]); else if (id == "note") note(flag " was ignored: " WHY[flag]); else apply(id, val, flag, 1)
      break
    }
  }
  if (i > TN) { err("No image was found in the command."); return }
  image = TK[i]; i++
  if (image ~ /\$/ ) { VARSEEN = 1 }
  setv("image", image)
  for (k = i; k <= TN; k++) addl("cmd", TK[k])
  if (OPTEXT != "") notconv(OPTEXT, "shell operators such as ; | & < > are not supported; the rest of the line was left out")
  if (EXTRA != "") notconv(EXTRA, "only the first command was converted")
}

# ---------- compose (the JSON of `docker compose config`) ----------
# >>> json flatten (the same text in convert.sh and git_services.sh; a test compares them): the JSON of docker compose config as paths
function jws(   c) { while (JP <= JL) { c = substr(JS, JP, 1); if (c == " " || c == "\n" || c == "\t" || c == "\r") JP++; else break } }
function hexv(h,   i, n, c) { n = 0; h = tolower(h); for (i = 1; i <= length(h); i++) { c = index("0123456789abcdef", substr(h, i, 1)); if (c == 0) return 63; n = n * 16 + c - 1 } return n }
function jstring(   c, o, n) {
  JP++; o = ""
  while (JP <= JL) {
    c = substr(JS, JP, 1)
    if (c == "\"") { JP++; return o }
    if (c == "\\") {
      JP++; c = substr(JS, JP, 1)
      if (c == "n") o = o "\n"; else if (c == "t") o = o "\t"; else if (c == "r") o = o "\r"; else if (c == "b") o = o "\b"; else if (c == "f") o = o "\f"
      else if (c == "u") { n = hexv(substr(JS, JP + 1, 4)); JP += 4; if (n > 0 && n < 128) o = o sprintf("%c", n); else if (n >= 128) o = o "?" }
      else o = o c
    } else o = o c
    JP++
  }
  return o
}
function jval(path,   c, k, n, t) {
  jws(); c = substr(JS, JP, 1)
  if (c == "{") {
    JT[path] = "o"; JP++; jws(); n = 0
    if (substr(JS, JP, 1) == "}") { JP++; JN[path] = 0; return }
    while (JP <= JL) {
      jws(); k = jstring(); jws(); JP++; n++; JK[path, n] = k
      jval(path SUBSEP k)
      jws(); c = substr(JS, JP, 1); JP++
      if (c == "}") break
    }
    JN[path] = n; return
  }
  if (c == "[") {
    JT[path] = "a"; JP++; jws(); n = 0
    if (substr(JS, JP, 1) == "]") { JP++; JN[path] = 0; return }
    while (JP <= JL) {
      n++; jval(path SUBSEP n)
      jws(); c = substr(JS, JP, 1); JP++
      if (c == "]") break
    }
    JN[path] = n; return
  }
  if (c == "\"") { JT[path] = "s"; JV[path] = jstring(); t0 = JV[path]; gsub(/\$\$/, "", t0); if (t0 ~ /\$[A-Za-z_{]/) VARSEEN = 1; gsub(/\$\$/, "$", JV[path]); return }
  k = JP
  while (JP <= JL) { c = substr(JS, JP, 1); if (c == "," || c == "}" || c == "]" || c == " " || c == "\n" || c == "\r" || c == "\t") break; JP++ }
  t = substr(JS, k, JP - k)
  if (t == "null") { JT[path] = "z"; JV[path] = ""; return }
  JT[path] = (t == "true" || t == "false") ? "b" : "n"; JV[path] = t
}
function ch(p, k) { return p SUBSEP k }
function has(p) { return (p in JT) && JT[p] != "z" }
function cstr(p) { return ((p in JT) && (JT[p] == "s" || JT[p] == "n" || JT[p] == "b")) ? JV[p] : "" }
function ctrue(p) { return (p in JT) && (JV[p] == "true" || JV[p] == "yes" || JV[p] == "1") && (JT[p] == "b" || JT[p] == "s" || JT[p] == "n") }
function isempty(p) { if (!(p in JT) || JT[p] == "z") return 1; if (JT[p] == "a" || JT[p] == "o") return JN[p] == 0; if (JT[p] == "b") return JV[p] == "false"; return JV[p] == "" }
# <<< json flatten
# the entries of a list or the words of a string: IT[1..IN] (a string is split like a shell would)
function words(p,   i, e) {
  IN = 0
  if (!has(p)) return
  if (JT[p] == "a") { for (i = 1; i <= JN[p]; i++) { e = ch(p, i); if (JT[e] == "s" || JT[e] == "n" || JT[e] == "b") IN_ADD(JV[e]) } return }
  if (JT[p] == "s") { e = tokenize(JV[p], 0); for (i = 1; i <= TN; i++) IN_ADD(TK[i]) }
}
function IN_ADD(v) { IN++; IT[IN] = v }
# the entries of a list, or the one string, as they are (no splitting)
function entries(p,   i, e) {
  IN = 0
  if (!has(p)) return
  if (JT[p] == "a") { for (i = 1; i <= JN[p]; i++) { e = ch(p, i); if (JT[e] == "s" || JT[e] == "n" || JT[e] == "b") IN_ADD(JV[e]) } return }
  if (JT[p] == "s" || JT[p] == "n") IN_ADD(JV[p])
}
# key=value pairs of a map, or the entries of a list of "k=v" strings: IT[1..IN]; a null value makes the text "k" alone
function pairs(p,   i, k, e) {
  IN = 0
  if (!has(p)) return
  if (JT[p] == "o") { for (i = 1; i <= JN[p]; i++) { k = JK[p, i]; e = ch(p, k); IN_ADD(((e in JT) && JT[e] != "z") ? k "=" JV[e] : k) } return }
  entries(p)
}
function ckey(sp, k) { HK[k] = 1; return ch(sp, k) }
function conv_service(sp, sname,   p, e, i, j, k, v, t, n, a, m, np, src, ty, ro, pp, h, tst, unk, key, why) {
  # name and image
  p = ckey(sp, "container_name"); setv("name", cstr(p) != "" ? cstr(p) : sname)
  p = ckey(sp, "image"); img = cstr(p); HK["build"] = 1; hb = has(ch(sp, "build"))
  if (img != "") setv("image", img)
  if (hb && img == "") err("Not converted: build (this service builds its image from a Dockerfile, which the editor cannot do; give the service an image instead)")
  else if (hb) err("Not converted: build (building the image from a Dockerfile is not supported; the image " img " is used as it is)")
  else if (img == "") err("The service " sname " has no image.")
  # command, entrypoint
  p = ckey(sp, "entrypoint")
  if (has(p)) {
    if (JT[p] == "a" && JN[p] == 0) addl("entrypoint", "")
    else { words(p); for (i = 1; i <= IN; i++) addl("entrypoint", IT[i]) }
  }
  p = ckey(sp, "command")
  if (has(p)) { words(p); for (i = 1; i <= IN; i++) addl("cmd", IT[i]) }
  # environment
  p = ckey(sp, "environment"); pairs(p)
  for (i = 1; i <= IN; i++) { if (IT[i] ~ /=/) addl("env", IT[i]); else err("Not converted: environment " IT[i] " (it takes its value from the environment of the host running docker compose; write KEY=value)") }
  p = ckey(sp, "env_file"); if (!isempty(p)) err("Not converted: env_file (the files are not available here; put the variables in environment)")
  p = ckey(sp, "labels"); pairs(p)
  for (i = 1; i <= IN; i++) addl("label", IT[i] ~ /=/ ? IT[i] : IT[i] "=")
  # ports
  p = ckey(sp, "ports")
  if (has(p) && JT[p] == "a") {
    for (i = 1; i <= JN[p]; i++) {
      e = ch(p, i)
      if (JT[e] == "o") {
        pp = cstr(ch(e, "target")); h = cstr(ch(e, "published")); t = cstr(ch(e, "host_ip")); k = cstr(ch(e, "protocol"))
        if (pp == "") { err("Not converted: ports entry without a target port"); continue }
        v = pp; if (k != "" && k != "tcp") v = v "/" k
        if (h != "" || t != "") { if (t ~ /:/) t = "[" t "]"; v = (t != "" ? t ":" : "") h ":" v }
        addl("port", v)
      } else if (JT[e] == "s" || JT[e] == "n") {
        v = JV[e]
        if (chkport(v)) addl("port", v); else err("Not converted: ports " v " (not a valid port mapping)")
      }
    }
  }
  p = ckey(sp, "expose"); if (!isempty(p)) note("expose was ignored: it only documents ports, nothing is published")
  # volumes
  p = ckey(sp, "volumes")
  if (has(p) && JT[p] == "a") {
    for (i = 1; i <= JN[p]; i++) {
      e = ch(p, i)
      if (JT[e] == "s") {
        v = JV[e]; n = split(v, a, ":")
        if (n == 1) { err("Not converted: volumes " v " (anonymous volumes are not supported: give the volume a name)"); continue }
        if (a[2] !~ /^\// ) { err("Not converted: volumes " v " (the target must be an absolute path)"); continue }
        if (a[1] !~ /^\// && !validname(a[1])) { err("Not converted: volumes " v " (a relative host path is not supported: use an absolute path or a volume name)"); continue }
        ro = 0; if (n == 3) { m = split(a[3], hh, ","); for (j = 1; j <= m; j++) if (hh[j] == "ro") ro = 1; else if (hh[j] != "rw" && hh[j] != "z" && hh[j] != "Z") err("Not converted: volumes " v " (the option " hh[j] " is not supported)") }
        addl("volume", a[1] ":" a[2] (ro ? ":ro" : "")); continue
      }
      if (JT[e] != "o") continue
      ty = cstr(ch(e, "type")); src = cstr(ch(e, "source")); t = cstr(ch(e, "target")); ro = ctrue(ch(e, "read_only"))
      if (ty == "tmpfs") {
        v = t; k = cstr(ch(ch(e, "tmpfs"), "size")); if (k != "") v = v ":size=" k
        addl("tmpfs", v); continue
      }
      if (ty == "bind") {
        if (index(src, PROJ "/") == 1 || src == PROJ) { err("Not converted: volumes " shq("./" substr(src, length(PROJ) + 2) ":" t) " (a relative host path is not supported: use an absolute path)"); continue }
        if (has(ch(ch(e, "bind"), "propagation")) || has(ch(ch(e, "bind"), "selinux"))) err("Not converted: volumes " src ":" t " (bind options other than read-only are not supported)")
        addl("volume", src ":" t (ro ? ":ro" : "")); continue
      }
      if (ty == "volume") {
        if (src == "") { err("Not converted: volumes " t " (anonymous volumes are not supported: give the volume a name)"); continue }
        vp = ch(ch(JROOT, "volumes"), src)
        if (has(vp)) {
          if (ctrue(ch(vp, "external")) && cstr(ch(vp, "name")) != "") src = cstr(ch(vp, "name"))
          else if (cstr(ch(vp, "name")) != "" && index(cstr(ch(vp, "name")), PROJNAME "_") != 1) src = cstr(ch(vp, "name"))
          if (has(ch(vp, "driver")) || has(ch(vp, "driver_opts"))) err("Not converted: the driver options of the volume " src " (create the volume first)")
        }
        addl("volume", src ":" t (ro ? ":ro" : "")); continue
      }
      err("Not converted: volumes of type " ty " (" src ":" t ")")
    }
  }
  p = ckey(sp, "tmpfs"); entries(p); for (i = 1; i <= IN; i++) addl("tmpfs", IT[i])
  # network
  p = ckey(sp, "network_mode")
  if (cstr(p) != "") {
    v = cstr(p)
    if (v == "host" || v == "none" || v == "bridge") setv("network", v)
    else err("Not converted: network_mode " v " (only host, none and bridge are supported)")
  }
  p = ckey(sp, "networks")
  if (has(p) && JT[p] == "o") {
    nn = 0
    for (i = 1; i <= JN[p]; i++) {
      k = JK[p, i]; e = ch(p, k); np = ch(ch(JROOT, "networks"), k)
      if (k == "default") { if (has(e) && JT[e] == "o") { for (j = 1; j <= JN[ch(e, "aliases")]; j++) addl("network_alias", JV[ch(ch(e, "aliases"), j)]) } continue }
      v = k
      if (has(np)) {
        if (ctrue(ch(np, "external")) && cstr(ch(np, "name")) != "") v = cstr(ch(np, "name"))
        else if (cstr(ch(np, "name")) != "" && index(cstr(ch(np, "name")), PROJNAME "_") != 1) v = cstr(ch(np, "name"))
        else { err("Not converted: networks " k " (the network is defined in the compose file and does not exist yet: create it, mark it external, or use a stack)"); continue }
      } else { err("Not converted: networks " k " (the network is not defined at the top level)"); continue }
      nn++
      if (nn > 1) { err("Not converted: networks " v " (only one network can be set; " NETSET " is used)"); continue }
      NETSET = v; setv("network", v)
      if (has(e) && JT[e] == "o") {
        for (j = 1; j <= JN[ch(e, "aliases")]; j++) addl("network_alias", JV[ch(ch(e, "aliases"), j)])
        for (j = 1; j <= JN[e]; j++) { key = JK[e, j]; if (key != "aliases") err("Not converted: networks " k " " key " (not supported by the editor)") }
      }
    }
  }
  p = ckey(sp, "restart"); if (cstr(p) != "") { v = cstr(p); if (v ~ /^(no|always|unless-stopped|on-failure(:[0-9]+)?)$/) setv("restart", v); else err("Not converted: restart " v " (use no, always, unless-stopped, on-failure or on-failure:N)") }
  p = ckey(sp, "hostname"); if (cstr(p) != "") setv("hostname", cstr(p))
  p = ckey(sp, "user"); if (cstr(p) != "") setv("user", cstr(p))
  p = ckey(sp, "working_dir"); if (cstr(p) != "") setv("workdir", cstr(p))
  p = ckey(sp, "mem_limit"); if (cstr(p) != "") { v = cstr(p); if (v ~ /^[0-9]+[bkmgBKMG]?$/) setv("memory", tomem(v)); else err("Not converted: mem_limit " v " (use a number with an optional unit)") }
  p = ckey(sp, "cpus"); if (cstr(p) != "") setv("cpus", cstr(p))
  p = ckey(sp, "dns"); entries(p); for (i = 1; i <= IN; i++) addl("dns", IT[i])
  p = ckey(sp, "extra_hosts"); pairs(p)
  for (i = 1; i <= IN; i++) { v = IT[i]; if (v ~ /=/ && v !~ /:/) sub(/=/, ":", v); addl("add_host", v) }
  p = ckey(sp, "logging")
  if (has(p)) {
    if (cstr(ch(p, "driver")) != "") setv("log_driver", cstr(ch(p, "driver")))
    pairs(ch(p, "options")); for (i = 1; i <= IN; i++) addl("log_opt", IT[i])
  }
  p = ckey(sp, "stop_signal"); if (cstr(p) != "") setv("stop_signal", cstr(p))
  p = ckey(sp, "stop_grace_period")
  if (cstr(p) != "") { v = todursec(cstr(p)); if (v == "") err("Not converted: stop_grace_period " cstr(p) " (not a valid duration)"); else setv("stop_timeout", v) }
  p = ckey(sp, "tty"); if (has(p)) setv("tty", ctrue(p) ? "true" : "false")
  p = ckey(sp, "stdin_open"); if (has(p)) setv("interactive", ctrue(p) ? "true" : "false")
  p = ckey(sp, "init"); if (has(p)) setv("init", ctrue(p) ? "true" : "false")
  p = ckey(sp, "read_only"); if (has(p)) setv("read_only", ctrue(p) ? "true" : "false")
  p = ckey(sp, "privileged"); if (has(p)) setv("privileged", ctrue(p) ? "true" : "false")
  p = ckey(sp, "pid"); if (cstr(p) != "") { if (cstr(p) == "host") setv("pid", "host"); else err("Not converted: pid " cstr(p) " (only host is supported)") }
  p = ckey(sp, "ipc"); if (cstr(p) != "") { if (cstr(p) == "host") setv("ipc", "host"); else err("Not converted: ipc " cstr(p) " (only host is supported)") }
  p = ckey(sp, "cap_add"); entries(p); for (i = 1; i <= IN; i++) addl("cap_add", IT[i])
  p = ckey(sp, "cap_drop"); entries(p); for (i = 1; i <= IN; i++) addl("cap_drop", IT[i])
  p = ckey(sp, "security_opt"); entries(p); for (i = 1; i <= IN; i++) addl("security_opt", IT[i])
  p = ckey(sp, "sysctls"); pairs(p); for (i = 1; i <= IN; i++) addl("sysctl", IT[i])
  p = ckey(sp, "devices")
  if (has(p) && JT[p] == "a") {
    for (i = 1; i <= JN[p]; i++) {
      e = ch(p, i)
      if (JT[e] == "o") { v = cstr(ch(e, "source")) ":" cstr(ch(e, "target")); if (cstr(ch(e, "permissions")) != "") v = v ":" cstr(ch(e, "permissions")); addl("device", v) }
      else addl("device", JV[e])
    }
  }
  # health check
  p = ckey(sp, "healthcheck")
  if (has(p)) {
    if (ctrue(ch(p, "disable"))) err("Not converted: healthcheck disable (the editor cannot disable a health check)")
    tst = ch(p, "test")
    if (has(tst)) {
      if (JT[tst] == "s") setv("health_cmd", JV[tst])
      else if (JT[tst] == "a" && JN[tst] > 0) {
        k = JV[ch(tst, 1)]
        if (k == "CMD-SHELL") setv("health_cmd", JV[ch(tst, 2)])
        else if (k == "CMD") { v = ""; for (j = 2; j <= JN[tst]; j++) v = v (j > 2 ? " " : "") shq(JV[ch(tst, j)]); setv("health_cmd", v) }
        else if (k == "NONE") err("Not converted: healthcheck test NONE (the editor cannot disable a health check)")
        else { v = ""; for (j = 1; j <= JN[tst]; j++) v = v (j > 1 ? " " : "") shq(JV[ch(tst, j)]); setv("health_cmd", v) }
      }
    }
    if (cstr(ch(p, "interval")) != "") { v = todur(cstr(ch(p, "interval"))); if (v == "") err("Not converted: healthcheck interval " cstr(ch(p, "interval")) " (not a valid duration)"); else setv("health_interval", v) }
    if (cstr(ch(p, "timeout")) != "") { v = todur(cstr(ch(p, "timeout"))); if (v == "") err("Not converted: healthcheck timeout " cstr(ch(p, "timeout")) " (not a valid duration)"); else setv("health_timeout", v) }
    if (cstr(ch(p, "retries")) != "") setv("health_retries", cstr(ch(p, "retries")))
    if (cstr(ch(p, "start_period")) != "") err("Not converted: healthcheck start_period " cstr(ch(p, "start_period")) " (the health check start period is not supported by the editor)")
    if (cstr(ch(p, "start_interval")) != "") err("Not converted: healthcheck start_interval " cstr(ch(p, "start_interval")) " (not supported by the editor)")
  }
  # gpus and the limits of deploy
  p = ckey(sp, "gpus")
  if (has(p)) { if (cstr(p) == "all") setv("gpus", "all"); else err("Not converted: gpus (only all is supported here)") }
  p = ckey(sp, "deploy")
  if (has(p)) {
    for (i = 1; i <= JN[p]; i++) {
      k = JK[p, i]
      if (k != "resources") { err("Not converted: deploy " k " (only resource limits and GPU reservations are converted)"); continue }
      e = ch(p, "resources")
      for (j = 1; j <= JN[e]; j++) {
        key = JK[e, j]
        if (key == "limits") {
          m = ch(e, "limits")
          for (n = 1; n <= JN[m]; n++) {
            k = JK[m, n]
            if (k == "cpus") setv("cpus", cstr(ch(m, "cpus")))
            else if (k == "memory") { v = cstr(ch(m, "memory")); if (v ~ /^[0-9]+[bkmgBKMG]?$/) setv("memory", tomem(v)); else err("Not converted: deploy.resources.limits.memory " v " (use a number with an optional unit)") }
            else err("Not converted: deploy.resources.limits." k " (not supported by the editor)")
          }
        } else if (key == "reservations") {
          m = ch(e, "reservations")
          for (n = 1; n <= JN[m]; n++) {
            k = JK[m, n]
            if (k == "devices") {
              for (a1 = 1; a1 <= JN[ch(m, "devices")]; a1++) {
                dv = ch(ch(m, "devices"), a1)
                v = cstr(ch(dv, "count")); if (v == "") v = "all"
                if (index(cstr(ch(dv, "driver")), "nvidia") > 0 || has(ch(dv, "capabilities"))) setv("gpus", v == "-1" ? "all" : v)
                else err("Not converted: deploy.resources.reservations.devices (only GPUs are supported)")
              }
            } else err("Not converted: deploy.resources.reservations." k " (not supported by the editor)")
          }
        } else err("Not converted: deploy.resources." key " (not supported by the editor)")
      }
    }
  }
  # everything else that the editor cannot express
  for (i = 1; i <= JN[sp]; i++) {
    k = JK[sp, i]
    if (k in HK) continue
    p = ch(sp, k)
    if (isempty(p)) continue
    why = "not supported by the editor"
    if (k == "depends_on") why = "the start order of services is not supported: deploy it as a stack instead"
    else if (k == "secrets" || k == "configs") why = "files from the compose project are not available here"
    else if (k == "profiles") why = "profiles are not supported"
    else if (k == "extends" || k == "links" || k == "external_links" || k == "volumes_from") why = "not supported by the editor"
    else if (k == "ulimits" || k == "shm_size" || k == "group_add" || k == "cgroup_parent" || k == "dns_search" || k == "dns_opt" || k == "cpu_shares" || k == "cpuset" || k == "pids_limit" || k == "mem_reservation" || k == "memswap_limit" || k == "oom_score_adj" || k == "mac_address") why = "not in the list of settings the editor can set"
    else if (k == "pull_policy") { note("pull_policy was ignored: a missing image is pulled, an existing one is used as it is"); continue }
    err("Not converted: " k " (" why ")")
  }
}
function convert_compose(   line, svc, first, i, n, names, others, k, sp) {
  JS = ""
  while ((getline line < CFGFILE) > 0) JS = JS line "\n"
  close(CFGFILE)
  JL = length(JS); JP = 1; JROOT = "R"
  jval(JROOT)
  if (!has(ch(JROOT, "services")) || JN[ch(JROOT, "services")] < 1) { err("The compose file has no services."); return }
  PROJNAME = "bosun-convert"
  # the first service of the file (compose prints them sorted)
  first = ""
  n = split(TEXT, LINES, "\n"); ins = 0; sind = -1
  for (i = 1; i <= n; i++) {
    line = LINES[i]
    if (!ins) { if (line ~ /^services[ \t]*:/) ins = 1; continue }
    if (line ~ /^[ \t]*(#.*)?$/) continue
    if (line ~ /^[^ \t]/) break
    match(line, /^[ \t]*/)
    if (sind < 0) sind = RLENGTH
    if (RLENGTH == sind && line ~ /^[ \t]*[^ \t#-][^:]*:/) { first = line; sub(/^[ \t]*/, "", first); sub(/[ \t]*:.*/, "", first); gsub(/^["']|["']$/, "", first); break }
  }
  sp0 = ch(JROOT, "services")
  if (first == "" || !has(ch(sp0, first))) first = JK[sp0, 1]
  names = ""
  for (i = 1; i <= JN[sp0]; i++) if (JK[sp0, i] != first) names = names (names == "" ? "" : ", ") JK[sp0, i]
  if (names != "") note("The compose file has more than one service; only " first " was converted (not converted: " names ")")
  conv_service(ch(sp0, first), first)
  if (VARSEEN) note("Compose variables such as ${VAR} are not expanded: they are kept as text, so replace them with their values")
}

# ---------- main ----------
{ TEXT = TEXT $0 "\n" }
END {
  if (MODE == "compose") convert_compose()
  else {
    t = tokenize(TEXT, 1)
    if (t == "$(...)") err("Refused: the text contains $(...) (command substitution). Bosun never runs anything from the pasted text: replace it with its value and convert again.")
    else if (t == "backticks") err("Refused: the text contains backticks (`...`, command substitution). Bosun never runs anything from the pasted text: replace them with the value and convert again.")
    else if (t != "") err("The command has an unterminated quote.")
    else if (TN == 0) err("Paste a docker run command or a compose file.")
    else {
      convert_run()
      if (VARSEEN) note("Variables such as $VAR are kept as text: Docker does not expand them here, so replace them with their values")
    }
  }
  emit()
}
BOSUN_AWK_END
if ! awk -v MODE="$MODE" -v CFGFILE="$tmp/cfg" -v PROJ="$PROJ" -f "$tmp/prog.awk" "$tmp/in" > "$tmp/out" 2> "$tmp/err"; then
  echo "ERROR: the conversion failed: $(tr -d '\r' < "$tmp/err" | tail -n 1 | cut -c1-200)"; exit 0
fi
cat "$tmp/out"
exit 0
