#!/bin/sh
# Docker (Linux), dataset: the networks of the host as one JSON array of
# {"id","name","driver","scope","subnet","gateway","containers":N,"internal":bool} (subnet and gateway of the first address pool, or empty).
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
if ! $D ps >/dev/null 2>&1; then echo 'Docker is not available to this account (not installed, not running, or no access)' >&2; exit 3; fi
ids=$($D network ls -q --no-trunc 2>/dev/null)
if [ -z "$ids" ]; then echo '[]'; exit 0; fi
set -f; set -- $ids; set +f
fmt='{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"subnet":{{if .IPAM.Config}}{{json (index .IPAM.Config 0).Subnet}}{{else}}""{{end}},"gateway":{{if .IPAM.Config}}{{json (index .IPAM.Config 0).Gateway}}{{else}}""{{end}},"containers":{{len .Containers}},"internal":{{.Internal}}}'
if ! rows=$($D network inspect --format "$fmt" "$@" 2>&1); then
  echo "docker network inspect failed: $(printf '%s' "$rows" | tail -n 1 | cut -c1-200)" >&2; exit 1
fi
printf '%s\n' "$rows" | awk 'BEGIN { printf "[" } NF { if (n++) printf ","; printf "%s", $0 } END { print "]" }'
