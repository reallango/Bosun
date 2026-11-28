#!/bin/sh
# Docker (Linux): the summary numbers of the dashboard widget, as `dotted.key=value` lines (a state probe).
# The Docker version, the number of compose stacks, how many containers run and how many are healthy, containers in an
# error state and their average uptime, and how many images have a newer tag in their registry. Nothing is pulled or
# restarted; a registry that cannot be read is counted as unknown instead of as an update.
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'docker.available=false'; exit 0; fi
echo 'docker.available=true'

version=$($D version --format '{{.Server.Version}}' 2>/dev/null | head -n 1 | tr -d '\r')
[ -n "$version" ] && printf 'docker.version=%s\n' "$version"

# One line per container: state, status, compose project. `docker ps` prints the health and the exit code inside Status
# ("Up 3 hours (healthy)", "Exited (1) 2 days ago", "Restarting (1) ...").
$D ps -a --no-trunc --format '{{.ID}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null | tr -d '\r' | awk -F '|' '
  function health(s) { if (s ~ /\(healthy\)/) return "healthy"; if (s ~ /\(unhealthy\)/) return "unhealthy"; if (s ~ /\(health: starting\)/) return "starting"; return "" }
  function exit_code(s) { if (match(s, /\([0-9]+\)/)) return substr(s, RSTART + 1, RLENGTH - 2) + 0; return 0 }
  $1 == "" { next }
  {
    total++
    if ($2 == "running") running++
    h = health($3)
    if (h != "") { health_total++; if (h == "healthy") healthy++ }
    e = ($2 == "restarting" || $2 == "dead") ? 1 : (($2 == "exited" && exit_code($3) != 0) ? 1 : 0)
    if (h == "unhealthy") e = 1
    if (e) errors++
    if ($4 != "") stacks[$4] = 1
  }
  END {
    stopped = total - running
    n = 0; for (s in stacks) n++
    printf "docker.total=%d\n", total
    printf "docker.running=%d\n", running
    printf "docker.stopped=%d\n", stopped
    printf "docker.stacks=%d\n", n
    printf "docker.split=%d running · %d stopped\n", running, stopped
    printf "docker.errors=%d\n", errors
    printf "docker.health_total=%d\n", health_total
    printf "docker.healthy=%d\n", healthy
    if (total > 0) {
      printf "docker.running_pct=%d\n", (running * 100 / total) + 0.5
      printf "docker.stopped_pct=%d\n", (stopped * 100 / total) + 0.5
    }
    if (health_total > 0) printf "docker.healthy_pct=%d\n", (healthy * 100 / health_total) + 0.5
  }'

# The average uptime of the running containers, in seconds (the time since each one started).
now=$(date +%s 2>/dev/null)
if [ -n "$now" ]; then
  sum=0; n=0
  for id in $($D ps -q 2>/dev/null); do
    started=$($D inspect --format '{{.State.StartedAt}}' "$id" 2>/dev/null | tr -d '\r')
    [ -n "$started" ] || continue
    t=$(date -d "$started" +%s 2>/dev/null) || continue
    [ "$t" -le "$now" ] || continue
    sum=$((sum + now - t)); n=$((n + 1))
  done
  [ "$n" -gt 0 ] && printf 'docker.avg_uptime=%d\n' $((sum / n))
fi

# How many containers use an image whose tag points to a newer digest in its registry. The comparison mirrors the
# `image_updates` dataset (`docker buildx imagetools` when it is there, otherwise `docker manifest inspect -v`, whose
# Ref carries the index digest of a multi-architecture tag); a lookup that fails is counted as unknown, never as an
# update. An image created from an id or pinned by digest, and a locally built image, are left out.
tmp=$(mktemp -d 2>/dev/null) || exit 0
trap 'rm -rf "$tmp"' EXIT
$D ps -a --no-trunc --format '{{.Image}}' 2>/dev/null | tr -d '\r' | sort -u > "$tmp/refs"
updates=0; unknown=0; checked=0
use_buildx=0; $D buildx version >/dev/null 2>&1 && use_buildx=1
TMO=''; command -v timeout >/dev/null 2>&1 && TMO='timeout 20'
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  case "$ref" in *@sha256:*|sha256:*) continue ;; esac
  # A bare image id (no tag, no slash) has no registry tag to compare with.
  case "$ref" in
    */*|*:*) ;;
    *) if [ "${#ref}" -ge 12 ] && [ "${#ref}" -le 64 ] && [ -z "$(printf '%s' "$ref" | tr -d '0-9a-f')" ]; then continue; fi ;;
  esac
  # The repository part (a tag is after the last colon, but only when it comes after the last slash).
  case "$ref" in
    */*) prefix=${ref%/*}; base=${ref##*/} ;;
    *) prefix=''; base=$ref ;;
  esac
  case "$base" in *:*) repo="${prefix:+$prefix/}${base%%:*}" ;; *) repo=$ref ;; esac
  digests=$($D image inspect --format '{{json .RepoDigests}}' "$ref" 2>/dev/null | tr -d '\r')
  case "$digests" in ''|'[]'|'null') continue ;; esac
  local_digest=$(printf '%s' "$digests" | tr -d '[]" ' | tr ',' '\n' | awk -F '@' -v p="$repo" '
    function norm(r) { sub(/^index\.docker\.io\//, "", r); sub(/^registry-1\.docker\.io\//, "", r); sub(/^docker\.io\//, "", r); sub(/^library\//, "", r); return r }
    norm($1) == norm(p) && $2 != "" { print $2; exit }')
  [ -n "$local_digest" ] || continue
  # An image built here records its own id as the repo digest; it has no registry tag to compare with.
  image_id=$($D image inspect --format '{{.Id}}' "$ref" 2>/dev/null | tr -d '\r' | sed 's/^sha256://')
  if [ -n "$image_id" ]; then case "$local_digest" in *"$image_id"*) continue ;; esac; fi
  if [ "$use_buildx" = 1 ]; then
    remote_digest=$($TMO $D buildx imagetools inspect --format '{{json .Manifest}}' "$ref" 2>/dev/null \
      | sed -n 's/.*"digest": *"\(sha256:[0-9a-fA-F]*\)".*/\1/p' | head -n 1)
  else
    manifest=$($TMO $D manifest inspect -v "$ref" 2>/dev/null)
    remote_digest=$(printf '%s' "$manifest" | sed -n 's/.*"Ref": *"[^"]*@\(sha256:[0-9a-fA-F]*\)".*/\1/p' | head -n 1)
    [ -n "$remote_digest" ] || remote_digest=$(printf '%s' "$manifest" | sed -n 's/.*"digest": *"\(sha256:[0-9a-fA-F]*\)".*/\1/p' | head -n 1)
  fi
  if [ -z "$remote_digest" ]; then unknown=$((unknown + 1)); continue; fi
  checked=$((checked + 1))
  [ "$remote_digest" = "$local_digest" ] || updates=$((updates + 1))
done < "$tmp/refs"
printf 'docker.updates=%d\n' "$updates"
printf 'docker.updates_checked=%d\n' "$checked"
printf 'docker.updates_unknown=%d\n' "$unknown"
exit 0
