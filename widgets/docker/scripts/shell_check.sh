#!/bin/sh
# Docker (Linux): decides whether an API key may get a shell in a container. Bosun runs this before it hands out an API
# terminal; the terminal itself is then a `docker exec` into the container named by the REF line printed here (the exact
# id, so what was checked is what runs).
#
# A shell is refused for anything that would let a root shell inside the container reach the host (and from there the
# administrator account): privileged containers, the host's PID, IPC, UTS, user or cgroup namespaces, dangerous
# capabilities, host devices, disabled security profiles, and bind mounts of sensitive host paths (the root, /etc, the
# Docker socket, ...). An inspection that cannot be read is never treated as safe.
# The container reference arrives as data (BOSUN_PARAM_ref).
ref="$BOSUN_PARAM_ref"
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }

# One line per fact, printed by Docker's own template engine (the host has no JSON parser).
fmt='ID {{.Id}}
{{if not .State.Running}}RISK it is not running
{{end}}{{if .HostConfig.Privileged}}RISK it is privileged
{{end}}{{if or (eq .HostConfig.PidMode "host") (eq (printf "%.10s" .HostConfig.PidMode) "container:")}}RISK it shares the host (or another container) PID namespace
{{end}}{{if eq .HostConfig.IpcMode "host"}}RISK it shares the host IPC namespace
{{end}}{{if eq .HostConfig.UTSMode "host"}}RISK it shares the host UTS namespace
{{end}}{{if eq .HostConfig.UsernsMode "host"}}RISK it disables user-namespace isolation
{{end}}{{if eq .HostConfig.CgroupnsMode "host"}}RISK it shares the host cgroup namespace
{{end}}{{if .HostConfig.Devices}}RISK it has host devices attached
{{end}}{{if .HostConfig.DeviceCgroupRules}}RISK it has device cgroup rules
{{end}}{{range .HostConfig.CapAdd}}CAP {{.}}
{{end}}{{range .HostConfig.SecurityOpt}}SEC {{.}}
{{end}}{{range .Mounts}}{{if eq .Type "bind"}}MOUNT {{.Source}}
{{end}}{{end}}{{range .HostConfig.Binds}}BIND {{.}}
{{end}}'
if ! info=$($D inspect --type container --format "$fmt" "$ref" 2>/dev/null); then
  echo 'ERROR: container shell refused: the container was not found or could not be inspected'
  exit 0
fi

# Is this host path (after resolving . and ..) a sensitive one, or inside one? The filesystem root counts as everything.
sensitive() {
  awk -v p="$1" '
    function norm(s,   n, i, a, k, out, st) {
      n = split(s, a, "/"); k = 0
      for (i = 1; i <= n; i++) { if (a[i] == "" || a[i] == ".") continue; if (a[i] == "..") { if (k > 0) k--; continue } k++; st[k] = a[i] }
      out = ""; for (i = 1; i <= k; i++) out = out "/" st[i]
      return out == "" ? "/" : out
    }
    BEGIN {
      p = norm(p)
      if (tolower(p) ~ /(docker|containerd|crio|podman)\.sock$/) exit 0
      if (p == "/") exit 0
      n = split("/etc /root /home /var/run /run /var/lib/docker /proc /sys /dev /boot /usr /bin /sbin /lib /lib64 /var/lib/containerd", r, " ")
      for (i = 1; i <= n; i++) if (p == r[i] || index(p, r[i] "/") == 1) exit 0
      exit 1
    }'
}

risks=''
add() { case "$risks" in *"$1"*) ;; *) risks="${risks:+$risks; }$1" ;; esac; }
id=''
badcaps=''
while IFS= read -r line; do
  case "$line" in
    "ID "*) id=${line#ID } ;;
    "RISK "*) add "${line#RISK }" ;;
    "CAP "*)
      c=$(printf '%s' "${line#CAP }" | tr 'a-z' 'A-Z' | sed 's/^CAP_//')
      case "$c" in ALL|SYS_ADMIN|SYS_PTRACE|SYS_MODULE|SYS_RAWIO|SYS_BOOT|DAC_READ_SEARCH|MKNOD|BPF|PERFMON|SYS_CHROOT) badcaps="${badcaps:+$badcaps, }$c" ;; esac ;;
    "SEC "*)
      s=$(printf '%s' "${line#SEC }" | tr 'A-Z' 'a-z')
      case "$s" in *unconfined*|*label:disable*|*label=disable*|*systempaths*) add 'its security profile is disabled' ;; esac ;;
    "MOUNT "*) src=${line#MOUNT }; if sensitive "$src"; then add "it mounts the host path $src"; fi ;;
    "BIND "*)
      b=${line#BIND }; src=${b%%:*}
      case "$src" in /*) if sensitive "$src"; then add "it mounts the host path $src"; fi ;; esac ;;
  esac
done <<EOF
$info
EOF
[ -z "$badcaps" ] || add "it has dangerous capabilities ($badcaps)"

if [ -n "$risks" ]; then echo "ERROR: container shell refused: $risks"; exit 0; fi
case "$id" in
  *[!0-9a-f]*|'') echo 'ERROR: container shell refused: unreadable container id'; exit 0 ;;
esac
[ ${#id} -eq 64 ] || { echo 'ERROR: container shell refused: unreadable container id'; exit 0; }
echo "REF $id"
echo 'DONE ok'
