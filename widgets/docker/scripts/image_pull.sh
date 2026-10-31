#!/bin/sh
# Docker (Linux): pulls an image (name[:tag] or name@digest) and reports progress as layers finish.
# Parameters: ref.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
ref=$BOSUN_PARAM_ref
case "$ref" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9._/:@-]*) fail 'invalid image reference' ;; esac
[ "${#ref}" -le 255 ] || fail 'invalid image reference'
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
logf=$(mktemp) || fail 'cannot create a temporary file'
codef=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$logf" "$codef"' EXIT
echo 'PROGRESS 0/1'
# The pipe hides docker's exit status, so it is added as a last line and written to a file.
{ $D pull "$ref" 2>&1; echo "BSB-EXIT $?"; } | {
  total=0; fin=0; last=''
  while IFS= read -r line; do
    case "$line" in
      'BSB-EXIT '*) printf '%s\n' "${line#BSB-EXIT }" > "$codef"; continue ;;
      *': Pulling fs layer'*|*': Waiting'*) total=$((total + 1)) ;;
      *': Pull complete'*|*': Already exists'*) fin=$((fin + 1)) ;;
    esac
    printf '%s\n' "$line" >> "$logf"
    [ "$total" -ge "$fin" ] || total=$fin
    if [ "$total" -gt 0 ] && [ "$last" != "$fin/$total" ]; then last="$fin/$total"; echo "PROGRESS $fin/$total"; fi
  done
}
if [ "$(cat "$codef" 2>/dev/null)" != 0 ]; then
  fail "$(tr -d '\r' < "$logf" | sed '/^$/d' | tail -n 1 | cut -c1-300)"
fi
echo "PROGRESS 1/1"
echo "DONE pulled $ref"
exit 0
