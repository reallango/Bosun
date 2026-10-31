#!/bin/sh
# Docker (Linux): removes unused images: the dangling ones (untagged layers), or with all=true every image no container uses.
# Says what it removed: `DONE removed 4 images, reclaimed 1.2GB`. Parameters: all (true/false).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
set -- image prune -f
[ "$BOSUN_PARAM_all" = true ] && set -- "$@" -a
tmp=$(mktemp -d) || fail 'cannot create a temporary folder'
trap 'rm -rf "$tmp"' EXIT
# The images before and after tell how many went (the output of prune also lists layers).
ids() { $D image ls -a -q --no-trunc 2>/dev/null | sort -u; }
echo 'PROGRESS 0/2'
if [ "$BOSUN_PARAM_all" = true ]; then echo '[step] Removing every image no container uses'; else echo '[step] Removing unused (untagged) images'; fi
ids > "$tmp/before"
if ! out=$($D "$@" 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/2'
ids > "$tmp/after"
n=$(comm -23 "$tmp/before" "$tmp/after" | grep -c .)
rec=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^[Tt]otal reclaimed space: *//p' | tail -n 1 | cut -c1-40)
[ -n "$rec" ] || rec=0B
case "$n" in 1) w=image ;; *) w=images ;; esac
echo 'PROGRESS 2/2'
echo "DONE removed $n $w, reclaimed $rec"
exit 0
