#!/bin/sh
# Docker (Linux), dataset: the ports an image declares (EXPOSE), each mapped to a random free host port, for the New container dialog:
#   {"fill":{"port":["49321:80/tcp","49322:443/tcp"]},"errors":[],"notes":["The image exposes 80/tcp, 443/tcp"]}
# A host port is free when it is in 49152-65535, nothing on the host listens on it (ss, or netstat when ss is missing), no
# container (running or not) publishes it, and it was not chosen for another port of this answer. A missing image is pulled first;
# when that fails the answer is {"fill":{"port":[]},"errors":["..."],"notes":[]}. An image without exposed ports gives "port":[] and a note.
# Nothing is created or changed on the host (an image may be pulled). Parameter: ref.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
ref=$BOSUN_PARAM_ref
case "$ref" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9._/:@-]*) fail 'invalid image reference' ;; esac
[ "${#ref}" -le 255 ] || fail 'invalid image reference'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || fail 'Docker is not available to this account'
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
jmsg() { printf '%s' "$1" | tr '\n\t' '  ' | tr -d '[:cntrl:]' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | cut -c1-400; }
answer_error() { printf '{"fill":{"port":[]},"errors":["%s"],"notes":[]}\n' "$(jmsg "$1")"; exit 0; }

# the image (pulled when missing)
if ! $D image inspect --format '{{.Id}}' "$ref" >/dev/null 2>&1; then
  if ! $D pull "$ref" >/dev/null 2>"$tmp/pullerr" < /dev/null; then
    answer_error "The image $ref is not on this host and could not be pulled: $(tr -d '\r' < "$tmp/pullerr" | sed '/^$/d' | tail -n 1)"
  fi
fi
# one declared port per line, e.g. 80/tcp (the template prints the keys of the map)
if ! $D image inspect --format '{{range $p, $v := .Config.ExposedPorts}}{{$p}}
{{end}}' "$ref" > "$tmp/exposed" 2>"$tmp/inspecterr"; then
  answer_error "The image $ref could not be inspected: $(tr -d '\r' < "$tmp/inspecterr" | sed '/^$/d' | tail -n 1)"
fi

# ports in use: listening on the host, and published by containers
: > "$tmp/used"
checked=1
if command -v ss >/dev/null 2>&1; then
  ss -ltnuH 2>/dev/null | awk '{ a = $5; sub(/.*:/, "", a); print a }' >> "$tmp/used"
  ss -ltnu 2>/dev/null | awk 'NR > 1 { a = $5; sub(/.*:/, "", a); print a }' >> "$tmp/used"
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltnu 2>/dev/null | awk '$1 ~ /^(tcp|udp)/ { a = $4; sub(/.*:/, "", a); print a }' >> "$tmp/used"
else
  checked=0
fi
ids=$($D ps -aq 2>/dev/null | tr -d '\r' | grep -E '^[0-9a-f]+$')
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  set -f; set -- $ids; set +f
  $D inspect --type container --format '{{range $p, $bs := .HostConfig.PortBindings}}{{range $bs}}{{.HostPort}}
{{end}}{{end}}' "$@" 2>/dev/null >> "$tmp/used"
fi
seed=$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' \n')
case "$seed" in ''|*[!0-9]*) seed=$(( $(date +%s) % 100000 * 7919 + $$ )) ;; esac

# the answer: the declared ports in numeric order, each with a random free host port
awk -v seed="$seed" -v checked="$checked" -v ref="$ref" '
  function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
  FILENAME == ARGV[1] {
    if ($0 ~ /^[0-9]+\/(tcp|udp|sctp)$/ && !($0 in seen)) { seen[$0] = 1; split($0, p, "/"); n++; port[n] = p[1] + 0; proto[n] = p[2] }
    else if ($0 != "") other = other (other == "" ? "" : ", ") $0
    next
  }
  { if ($0 ~ /^[0-9]+$/) used[$0 + 0] = 1 }
  END {
    # numeric order (the keys of a map come sorted as text)
    for (i = 2; i <= n; i++) { tp = port[i]; tr = proto[i]; j = i - 1; while (j >= 1 && (port[j] > tp || (port[j] == tp && proto[j] > tr))) { port[j + 1] = port[j]; proto[j + 1] = proto[j]; j-- } port[j + 1] = tp; proto[j + 1] = tr }
    srand(seed + 0)
    errs = ""; notes = ""; list = ""; desc = ""
    for (i = 1; i <= n; i++) {
      tries = 0
      do { h = 49152 + int(rand() * 16384); tries++ } while ((h in used) && tries < 20000)
      if (h in used) { errs = errs (errs == "" ? "" : ",") "\"No free host port was found for " port[i] "/" proto[i] ".\""; continue }
      used[h] = 1
      list = list (list == "" ? "" : ",") "\"" h ":" port[i] "/" proto[i] "\""
      desc = desc (desc == "" ? "" : ", ") port[i] "/" proto[i]
    }
    if (n == 0) notes = "\"" esc("The image " ref " does not expose any ports (no EXPOSE).") "\""
    else notes = "\"" esc("The image exposes " desc) "\""
    if (other != "") notes = notes ",\"" esc("Port ranges or unusual declarations were skipped: " other) "\""
    if (checked == 0) notes = notes (notes == "" ? "" : ",") "\"Neither ss nor netstat is installed, so the ports in use on this host could not be checked; only the ports of containers were avoided.\""
    printf "{\"fill\":{\"port\":[%s]},\"errors\":[%s],\"notes\":[%s]}\n", list, errs, notes
  }' "$tmp/exposed" "$tmp/used"
exit 0
