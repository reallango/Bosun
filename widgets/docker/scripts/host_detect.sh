#!/bin/sh
# Docker (Linux): whether Docker Engine and the Compose plugin are installed and running on this host, and whether Bosun can
# install them here (Debian, Ubuntu and their derivatives). One JSON object, for "Set up this server":
#   {"installed":bool,"running":bool,"version":"","compose":"","supported":bool,"system":"","note":""}
esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-120; }
have() { command -v "$1" >/dev/null 2>&1; }

system=''; supported=false; note=''
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  system=${PRETTY_NAME:-$ID}
  case " ${ID-} ${ID_LIKE-} " in *' debian '*|*' ubuntu '*|*' raspbian '*) supported=true ;; esac
fi
[ "$supported" = true ] || note='Bosun installs Docker on Debian and Ubuntu (and their derivatives) so far'

installed=false; running=false; version=''; compose=''
if have docker; then
  installed=true
  D=docker; docker info >/dev/null 2>&1 || { have sudo && sudo -n docker info >/dev/null 2>&1 && D='sudo -n docker'; }
  if $D info >/dev/null 2>&1; then
    running=true
    version=$($D version --format '{{.Server.Version}}' 2>/dev/null)
  else
    version=$(docker --version 2>/dev/null | sed -n 's/^Docker version \([^,]*\).*/\1/p')
    note='Docker is installed but not running, or this account cannot use it'
  fi
  compose=$($D compose version --short 2>/dev/null)
  [ -n "$compose" ] || { [ "$running" = true ] && note='The Docker Compose plugin is missing: install Docker again to add it'; }
fi

printf '{"installed":%s,"running":%s,"version":"%s","compose":"%s","supported":%s,"system":"%s","note":"%s"}\n' \
  "$installed" "$running" "$(esc "$version")" "$(esc "$compose")" "$supported" "$(esc "$system")" "$(esc "$note")"
exit 0
