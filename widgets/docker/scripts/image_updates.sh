#!/bin/sh
# Docker (Linux), dataset: whether the tag each container runs now points to a newer image in its registry. Nothing is
# pulled and nothing is restarted. One JSON array, a row per container (running and stopped):
#   {"container","stack","service","image","local_digest","remote_digest","update_available","update","note"}
# `image` is the reference the container was created from; `local_digest` is the digest of the image it runs, taken from
# that image's RepoDigests ("" for a locally built image); `remote_digest` is the digest the registry gives for the same
# reference ("" when it cannot be read); `update_available` is true, false, or null when it cannot be told, with the
# reason in `note`. `update` is the display text for the Manage table: "available", "up to date", or "".
# An image is a local build, reported "built locally" and never looked up, when it has no RepoDigests, or when every
# RepoDigest is the image's own id for a repository without a registry host and Docker does not record a pull for it.
# The containerd image store (the default since Docker 29) writes such a digest for a local build, so without that check
# a name like `myapp:api` would be looked up on Docker Hub, which refuses a repository it does not know.
# A registry answers with an index digest for a multi-architecture tag (which is what RepoDigests records after a pull)
# and with the manifest digest for a single-architecture image; both commands below give that exact digest.
# `docker buildx imagetools inspect --format '{{json .Manifest}}'` is used when buildx is installed, otherwise
# `docker manifest inspect -v`. Every distinct reference is looked up once per run, with a timeout, and a lookup that
# fails only sets `note`: it never fails the dataset. No registry credentials are printed.
# Parameter: mode. "list" (the default) prints the array; "summary" prints {"available","total","unknown"} for the
# Overview tile, without the rows.
mode=${BOSUN_PARAM_mode:-list}
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
S='|'; FSEP='[|]'
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
c="$tmp/c"; c2="$tmp/c2"; cid="$tmp/cid"; irepo="$tmp/irepo"; rows="$tmp/rows"; refinfo="$tmp/refinfo"; remote="$tmp/remote"; outf="$tmp/out"; lout="$tmp/lout"; errf="$tmp/err"

# The Descriptor.digest of every manifest in `docker manifest inspect -v` output (one for a single manifest).
descriptor_digests() {
  awk '
    {
      line = $0
      while (1) {
        if (!d) {
          if (match(line, /"Descriptor"[[:space:]]*:/)) { d = 1; line = substr(line, RSTART + RLENGTH); continue }
          break
        }
        if (match(line, /"digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-fA-F]+"/)) {
          s = substr(line, RSTART, RLENGTH)
          sub(/.*"digest"[[:space:]]*:[[:space:]]*"/, "", s); sub(/".*/, "", s)
          print s; d = 0; line = substr(line, RSTART + RLENGTH); continue
        }
        break
      }
    }
  ' "$1"
}

# The first digest in a buildx `.Manifest` (the index digest of a multi-architecture tag, or the manifest digest).
first_digest() {
  awk 'match($0, /"digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-fA-F]+"/) {
    s = substr($0, RSTART, RLENGTH); sub(/.*"digest"[[:space:]]*:[[:space:]]*"/, "", s); sub(/".*/, "", s); print s; exit
  }' "$1"
}

classify_error() { # $1 = exit code, $2 = stderr file; sets $note
  if [ "$1" = 124 ]; then note='registry lookup timed out'
  else
    msg=$(tr -d '\r' < "$2" 2>/dev/null | tail -n 1 | cut -c1-160 | tr -d "$S")
    case "$msg" in
      *[Uu]nauthorized*|*"authentication required"*|*[Dd]enied*|*"no basic auth"*|*"401"*) note='needs credentials' ;;
      *"not found"*|*"manifest unknown"*|*"no such manifest"*|*"404"*) note='reference not found in the registry' ;;
      *"connection refused"*|*"no such host"*|*"network is unreachable"*|*"i/o timeout"*|*"TLS handshake"*|*x509*|*"429"*|*"too many requests"*|*"dial tcp"*) note='registry unreachable' ;;
      *) note='registry lookup failed' ;;
    esac
  fi
}

# The registry host of a repository: "" for Docker Hub, which a name without a host implies.
registry_host() {
  case "$1" in */*) ;; *) return ;; esac
  h=${1%%/*}
  case "$h" in localhost|*.*|*:*) printf '%s' "$h" ;; esac
}

remote_failed() { # $1 = exit code, $2 = stderr file; uses $ref, $repo, $maybe
  classify_error "$1" "$2"
  # A refusal for a name that implies Docker Hub, on an image Docker does not record a pull for, means the repository
  # does not exist there: the image was built here. An image that came from a registry is not refused this way.
  if [ "$maybe" = 1 ] && [ -z "$(registry_host "$repo")" ]; then
    case "$note" in 'needs credentials'|'reference not found in the registry') note='built locally' ;; esac
  fi
  printf '%s|||%s\n' "$ref" "$note"
}

lookup_remote() { # $1 = reference, $2 = repository, $3 = local digest, $4 = may be a local build
  ref=$1; repo=$2; ldig=$3; maybe=$4
  : > "$errf"
  if [ "$use_buildx" = 1 ]; then
    $TMO $D buildx imagetools inspect --format '{{json .Manifest}}' "$ref" > "$outf" 2>"$errf"; rc=$?
    if [ "$rc" -ne 0 ]; then remote_failed "$rc" "$errf"; return; fi
    rd=$(first_digest "$outf")
    if [ -z "$rd" ]; then printf '%s|||%s\n' "$ref" 'could not read the digest from docker buildx'; return; fi
    printf '%s|%s||\n' "$ref" "$rd"
    return
  fi
  $TMO $D manifest inspect -v "$ref" > "$outf" 2>"$errf"; rc=$?
  if [ "$rc" -ne 0 ]; then remote_failed "$rc" "$errf"; return; fi
  shape=$(sed -n 's/^[[:space:]]*\([\[{]\).*/\1/p' "$outf" | head -n 1)
  case "$shape" in
    '{')
      rd=$(descriptor_digests "$outf" | head -n 1)
      if [ -z "$rd" ]; then printf '%s|||%s\n' "$ref" 'could not read the digest from docker manifest'; return; fi
      printf '%s|%s||\n' "$ref" "$rd"
      ;;
    '[')
      # A multi-architecture tag: docker manifest inspect -v gives the digest of each platform, not of the index.
      # Compare the platform manifests the registry has now with the ones of the index this image was pulled from.
      rset=$(descriptor_digests "$outf" | sort -u)
      if [ -z "$ldig" ]; then printf '%s|||%s\n' "$ref" 'cannot compare a multi-architecture image without a local digest'; return; fi
      : > "$errf"
      $TMO $D manifest inspect -v "$repo@$ldig" > "$lout" 2>"$errf"; lrc=$?
      if [ "$lrc" -ne 0 ]; then
        if [ "$lrc" = 124 ]; then n='comparing the multi-architecture image timed out'
        else classify_error "$lrc" "$errf"; n="cannot compare the multi-architecture image ($note)"; fi
        printf '%s|||%s\n' "$ref" "$n"; return
      fi
      lshape=$(sed -n 's/^[[:space:]]*\([\[{]\).*/\1/p' "$lout" | head -n 1)
      if [ "$lshape" = '{' ]; then
        ld=$(descriptor_digests "$lout" | head -n 1)
        if printf '%s\n' "$rset" | grep -Fxq "$ld"; then res=false; else res=true; fi
      else
        lset=$(descriptor_digests "$lout" | sort -u)
        if [ "$rset" = "$lset" ]; then res=false; else res=true; fi
      fi
      printf '%s||%s|%s\n' "$ref" "$res" 'compared by platform manifests (docker buildx is not installed)'
      ;;
    *) printf '%s|||%s\n' "$ref" 'could not read the manifest from the registry' ;;
  esac
}

# Every container, running or not, with the reference it was created from. A container created from an image id is left out.
$D ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' > "$c" 2>/dev/null
awk -F "$FSEP" '
  function idonly(v) { return v ~ /^sha256:[0-9a-fA-F]+$/ || (v ~ /^[0-9a-fA-F]+$/ && length(v) >= 12) }
  $1 != "" && $3 != "" && !idonly($3) { print }
' "$c" > "$c2"

# The image id of each container, then the RepoDigests of each image and where Docker says it came from (the containerd
# image store records "Pull" for an image that was pulled, "Build" for one built here, and nothing for an imported one).
ids=$(cut -d "$S" -f1 "$c2" | tr '\n' ' ')
if [ -n "$ids" ]; then
  set -f; set -- $ids; set +f
  $D inspect --type container --format "{{.Id}}$S{{.Image}}" "$@" > "$cid" 2>/dev/null
fi
: > "$irepo"
if [ -s "$cid" ]; then
  iids=$(cut -d "$S" -f2 "$cid" | sort -u | tr '\n' ' ')
  if [ -n "$iids" ]; then
    set -f; set -- $iids; set +f
    $D image inspect --format '{{.Id}}'"$S"'{{json .RepoDigests}}'"$S"'{{json (index . "Identity")}}' "$@" > "$irepo" 2>/dev/null
  fi
fi

# One row per container with its local digest and the reason when there is none.
awk -F "$FSEP" -v cidF="$cid" -v repoF="$irepo" -v S="$S" '
  function repo_of(r,  pre, base) {
    sub(/@.*/, "", r)
    sub(/^index\.docker\.io\//, "", r); sub(/^registry-1\.docker\.io\//, "", r); sub(/^docker\.io\//, "", r); sub(/^library\//, "", r)
    if (index(r, "/") > 0) { pre = r; sub(/\/[^\/]*$/, "", pre); base = r; sub(/^.*\//, "", base); if (index(base, ":") > 0) { sub(/:.*/, "", base); r = pre "/" base } }
    else if (index(r, ":") > 0) sub(/:.*/, "", r)
    return r
  }
  function repo_digest(json, repo,  raw, n, a, i, d) {
    raw = json; gsub(/[]["]/, "", raw)
    n = split(raw, a, ",")
    for (i = 1; i <= n; i++) if (index(a[i], repo "@") == 1) { d = a[i]; sub(/^.*@/, "", d); return d }
    return ""
  }
  function host_of(repo,  first) {
    first = repo
    if (sub(/\/.*/, "", first) == 0) return ""
    if (first == "localhost" || first ~ /[.:]/) return first
    return ""
  }
  # True when every RepoDigest is the own id of the image, for a repository with no registry host: what Docker records
  # for an image that was built here and never pulled or pushed.
  function own_digests(json, id,  raw, n, a, i, repo, dig) {
    raw = json; gsub(/[]["]/, "", raw)
    n = split(raw, a, ",")
    for (i = 1; i <= n; i++) {
      repo = a[i]; sub(/@.*/, "", repo)
      dig = a[i]; sub(/^.*@/, "", dig)
      if (host_of(repo) != "" || dig != id) return 0
    }
    return 1
  }
  BEGIN {
    while ((getline l < cidF) > 0) { split(l, a, FS); imgid[a[1]] = a[2] }
    while ((getline l < repoF) > 0) {
      split(l, a, FS); repod[a[1]] = a[2]
      prov[a[1]] = (a[3] == "" || a[3] == "null") ? "unknown" : (index(a[3], "\"Pull\"") > 0 ? "pulled" : "local")
    }
  }
  {
    cid = $1; name = $2; ref = $3; stack = $4; service = $5
    iid = imgid[cid]; repo = repo_of(ref); raw = repod[iid]; maybe = 0
    if (ref ~ /@sha256:/) { ld = ref; sub(/^.*@/, "", ld); type = "pinned"; note = "pinned by digest" }
    else {
      ld = repo_digest(raw, repo)
      if (raw == "" || raw == "[]" || raw == "null" || (prov[iid] == "local" && own_digests(raw, iid))) { type = "local"; ld = ""; note = "built locally" }
      else if (ld == "") { type = "local"; note = "no repo digest for this reference" }
      else if (repo == "bosun" || repo ~ /\/bosun$/) { type = "bosun"; note = "updated by Bosun\047s self-update" }
      else { type = "normal"; note = ""; maybe = (prov[iid] != "pulled" && own_digests(raw, iid)) ? 1 : 0 }
    }
    print name S ref S stack S service S ld S type S note S maybe
  }
' "$c2" > "$rows"

# The reference and its local digest once per distinct reference, for the registry lookup.
awk -F "$FSEP" -v S="$S" '
  function repo_of(r,  pre, base) {
    sub(/@.*/, "", r)
    sub(/^index\.docker\.io\//, "", r); sub(/^registry-1\.docker\.io\//, "", r); sub(/^docker\.io\//, "", r); sub(/^library\//, "", r)
    if (index(r, "/") > 0) { pre = r; sub(/\/[^\/]*$/, "", pre); base = r; sub(/^.*\//, "", base); if (index(base, ":") > 0) { sub(/:.*/, "", base); r = pre "/" base } }
    else if (index(r, ":") > 0) sub(/:.*/, "", r)
    return r
  }
  !seen[$2]++ { print $2 S $6 S $5 S repo_of($2) S $8 }
' "$rows" > "$refinfo"

# Ask the registry once for every reference that can be compared. buildx gives the index digest of a multi-architecture
# tag directly; docker manifest inspect is the fallback for hosts without it.
use_buildx=0
$D buildx version >/dev/null 2>&1 && use_buildx=1
TMO=""
command -v timeout >/dev/null 2>&1 && TMO="timeout 20"
: > "$remote"
while IFS="$S" read -r ref type ldig repo maybe; do
  [ "$type" = normal ] || continue
  lookup_remote "$ref" "$repo" "$ldig" "$maybe" >> "$remote"
done < "$refinfo"

# The rows, or the one-line summary for the Overview tile.
awk -F "$FSEP" -v rF="$remote" -v mode="$mode" '
  function esc(s,   o, n, k, c) {
    o = ""; n = length(s)
    for (k = 1; k <= n; k++) { c = substr(s, k, 1); if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " " || c == "\177") o = o ""; else o = o c }
    return o
  }
  BEGIN {
    while ((getline l < rF) > 0) { split(l, a, FS); rdig[a[1]] = a[2]; rres[a[1]] = a[3]; rnote[a[1]] = a[4] }
    if (mode != "summary") { printf "["; first = 1 }
  }
  {
    name = $1; ref = $2; stack = $3; service = $4; ld = $5; type = $6; note = $7
    rd = rdig[ref]; res = rres[ref]; rn = rnote[ref]
    ua = "null"; upd = ""
    if (type == "normal" && ld != "") {
      if (rd != "") { if (rd == ld) { ua = "false"; upd = "up to date" } else { ua = "true"; upd = "available" } }
      else if (res != "") { ua = res; upd = (res == "true" ? "available" : "up to date"); note = rn }
      else { note = (rn != "" ? rn : "registry lookup failed"); if (note == "built locally") ld = "" }
    }
    else if (type == "normal") { note = (note != "" ? note : "no local digest") }
    total++
    if (ua == "true") avail++; else if (ua == "null") unknown++
    if (mode == "summary") next
    if (!first) printf ","; first = 0
    printf "{\"container\":\"%s\",\"stack\":\"%s\",\"service\":\"%s\",\"image\":\"%s\",\"local_digest\":\"%s\",\"remote_digest\":\"%s\",\"update_available\":%s,\"update\":\"%s\",\"note\":\"%s\"}", esc(name), esc(stack), esc(service), esc(ref), esc(ld), esc(rd), ua, upd, esc(note)
  }
  END {
    if (mode == "summary") printf "{\"available\":%d,\"total\":%d,\"unknown\":%d}\n", avail, total, unknown
    else print "]"
  }
' "$rows"
