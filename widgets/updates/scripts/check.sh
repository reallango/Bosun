#!/bin/sh
# OS Update Check (Linux): lists the pending updates as JSON. Read-only: it only simulates an upgrade.
# Package names and versions never contain quotes or backslashes; any that did would have them removed.
have() { command -v "$1" >/dev/null 2>&1; }
reboot=false
[ -f /var/run/reboot-required ] && reboot=true
list=""
mgr=none
if have apt-get; then
  mgr=apt
  # Inst <name> [<current>] (<new> <origin> [<arch>])
  list=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' | head -n 300 | sed \
    -e 's/^Inst \([^ ]*\) \[\([^]]*\)\] (\([^ ]*\) \([^)]*\)).*/\1|\2|\3|\4/' -e t \
    -e 's/^Inst \([^ ]*\) (\([^ ]*\) \([^)]*\)).*/\1||\2|\3/' -e t \
    -e 's/^Inst \([^ ]*\).*/\1|||/')
elif have dnf; then
  mgr=dnf
  # <name>.<arch>  <new version>  <repo>
  list=$(dnf -q check-update 2>/dev/null | head -n 300 | awk 'NF>=3 && $1 ~ /\./ { print $1 "||" $2 "|" $3 }')
elif have yum; then
  mgr=yum
  list=$(yum -q check-update 2>/dev/null | head -n 300 | awk 'NF>=3 && $1 ~ /\./ { print $1 "||" $2 "|" $3 }')
fi
printf '%s\n' "$list" | awk -F'|' -v mgr="$mgr" -v reboot="$reboot" '
function clean(s) { gsub(/["\\]/, "", s); return s }
NF >= 4 && $1 != "" {
  n++
  sec = ($4 ~ /[Ss]ecurity/)
  if (sec) s++
  if (n <= 200) {
    item = sprintf("{\"name\":\"%s\",\"current_version\":\"%s\",\"new_version\":\"%s\",\"is_security\":%s}", clean($1), clean($2), clean($3), sec ? "true" : "false")
    items = items (items == "" ? "" : ",") item
  }
}
END { printf "{\"manager\":\"%s\",\"updatesAvailable\":%d,\"securityUpdates\":%d,\"rebootRequired\":%s,\"packages\":[%s]}\n", mgr, n + 0, s + 0, reboot, items }'
