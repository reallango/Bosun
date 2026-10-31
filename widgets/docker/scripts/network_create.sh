#!/bin/sh
# Docker (Linux): creates a network.
# Parameters: name, driver (empty = bridge), subnet (optional, CIDR; - or empty = none), gateway (optional, needs a subnet).
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
name=$BOSUN_PARAM_name; driver=$BOSUN_PARAM_driver; subnet=$BOSUN_PARAM_subnet; gateway=$BOSUN_PARAM_gateway
[ "$driver" != - ] || driver=; [ "$subnet" != - ] || subnet=; [ "$gateway" != - ] || gateway=
case "$name" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) fail 'invalid network name (letters, digits, _ . - only)' ;; esac
[ "${#name}" -le 128 ] || fail 'invalid network name'
case "$driver" in ''|[a-zA-Z0-9]*) ;; *) fail 'invalid network driver' ;; esac
case "$driver" in *[!a-zA-Z0-9_.:/-]*) fail 'invalid network driver' ;; esac
if [ -n "$subnet" ]; then
  case "$subnet" in */*) ;; *) fail 'the subnet needs the form 10.1.0.0/24' ;; esac
  case "${subnet%%/*}" in ''|*[!0-9A-Fa-f:.]*) fail 'invalid subnet' ;; esac
  case "${subnet#*/}" in ''|*[!0-9]*) fail 'invalid subnet' ;; esac
  [ "${#subnet}" -le 60 ] || fail 'invalid subnet'
fi
if [ -n "$gateway" ]; then
  [ -n "$subnet" ] || fail 'a gateway needs a subnet'
  case "$gateway" in *[!0-9A-Fa-f:.]*) fail 'invalid gateway' ;; esac
  [ "${#gateway}" -le 45 ] || fail 'invalid gateway'
fi
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 0; }
set -- network create
[ -z "$driver" ] || set -- "$@" --driver "$driver"
[ -z "$subnet" ] || set -- "$@" --subnet "$subnet"
[ -z "$gateway" ] || set -- "$@" --gateway "$gateway"
set -- "$@" "$name"
echo 'PROGRESS 0/1'
if ! out=$($D "$@" 2>&1); then fail "$(printf '%s\n' "$out" | tr -d '\r' | sed '/^$/d' | tail -n 1 | cut -c1-300)"; fi
echo 'PROGRESS 1/1'
echo "DONE created network $name"
exit 0
