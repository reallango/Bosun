#!/bin/sh
# Docker (Linux): installs Docker Engine with the Compose and Buildx plugins from Docker's own apt repository, on Debian, Ubuntu
# and their derivatives (ID_LIKE). The repository key is only trusted when its fingerprint is Docker's published one. Then
# Docker is started (systemd, or the init script where there is no systemd) and this account joins the docker group.
# Needs passwordless sudo (the account Bosun provisions has it). Already installed with Compose and running: nothing to do.
# Progress: PROGRESS n/6 and [step] lines.
fail() { printf 'ERROR: %s\n' "$*"; exit 0; }
have() { command -v "$1" >/dev/null 2>&1; }
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

if [ "$(id -u)" = 0 ]; then S=''
else
  have sudo && sudo -n true 2>/dev/null || fail 'installing Docker needs passwordless sudo for this account (provision the server again with an administrator)'
  S='sudo -n'
fi
D="${S:+$S }docker"
if have docker && $D info >/dev/null 2>&1 && $D compose version >/dev/null 2>&1; then
  echo 'PROGRESS 6/6'
  echo "DONE Docker $($D version --format '{{.Server.Version}}' 2>/dev/null) is already installed and running"
  exit 0
fi

[ -r /etc/os-release ] || fail 'cannot tell which Linux this is (no /etc/os-release)'
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID-} " in
  ' ubuntu ') distro=ubuntu ;;
  ' debian '|' raspbian ') distro=debian ;;
  *) case " ${ID_LIKE-} " in
       *' ubuntu '*) distro=ubuntu ;;
       *' debian '*) distro=debian ;;
       *) fail "installing Docker is supported on Debian and Ubuntu (and their derivatives) so far; this is ${PRETTY_NAME:-$ID}" ;;
     esac ;;
esac
# Derivatives name their own release; Docker's repository knows the Ubuntu or Debian release underneath.
if [ "$distro" = ubuntu ]; then codename=${UBUNTU_CODENAME:-${VERSION_CODENAME-}}; else codename=${DEBIAN_CODENAME:-${VERSION_CODENAME-}}; fi
case "$codename" in ''|*[!a-z0-9]*) fail 'cannot tell the release codename of this system' ;; esac
have apt-get && have dpkg || fail 'apt-get and dpkg are needed'
arch=$(dpkg --print-architecture) || fail 'cannot tell the architecture'
case "$arch" in ''|*[!a-z0-9]*) fail 'unexpected architecture' ;; esac

errf=$(mktemp) || fail 'cannot create a temporary file'
key=$(mktemp) || fail 'cannot create a temporary file'
trap 'rm -f "$errf" "$key"' EXIT
lastline() { tail -n 1 "$errf" | tr -d '\r' | cut -c1-300; }
apt() { $S env DEBIAN_FRONTEND=noninteractive apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }

echo 'PROGRESS 1/6'
echo "[step] Preparing $PRETTY_NAME ($distro $codename, $arch)"
apt update >/dev/null 2>"$errf" || fail "apt-get update failed: $(lastline)"
apt install ca-certificates curl gnupg >/dev/null 2>"$errf" || fail "installing curl and gnupg failed: $(lastline)"

echo 'PROGRESS 2/6'
echo "[step] Adding Docker's apt repository (download.docker.com)"
curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$distro/gpg" -o "$key" 2>"$errf" || fail "downloading Docker's repository key failed: $(lastline)"
fpr=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[ "$fpr" = "$DOCKER_KEY_FPR" ] || fail "Docker's repository key has an unexpected fingerprint (${fpr:-none}); nothing was installed"
$S install -d -m 0755 /etc/apt/keyrings || fail 'cannot create /etc/apt/keyrings'
$S install -m 0644 "$key" /etc/apt/keyrings/docker.asc || fail 'cannot store the repository key'
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$distro" "$codename" \
  | $S tee /etc/apt/sources.list.d/docker.list >/dev/null || fail 'cannot add the repository'

echo 'PROGRESS 3/6'
echo '[step] Installing Docker Engine, Compose and Buildx'
apt update >/dev/null 2>"$errf" || fail "apt-get update failed: $(lastline)"
apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>"$errf" \
  || fail "installing Docker failed: $(lastline)"

echo 'PROGRESS 4/6'
echo '[step] Starting Docker'
if [ -d /run/systemd/system ] && have systemctl; then
  $S systemctl enable --now docker >/dev/null 2>"$errf" || fail "starting Docker failed: $(lastline)"
else
  $S service docker start >/dev/null 2>"$errf" || fail "starting Docker failed: $(lastline)"
fi
i=0
until $S docker info >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail 'Docker did not start within 30 seconds'
  sleep 1
done

echo 'PROGRESS 5/6'
if [ -n "$S" ]; then
  me=$(id -un)
  echo "[step] Letting $me use Docker (docker group)"
  $S usermod -aG docker "$me" 2>"$errf" || fail "adding $me to the docker group failed: $(lastline)"
fi

echo 'PROGRESS 6/6'
echo "DONE installed Docker $($S docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose $($S docker compose version --short 2>/dev/null)"
exit 0
