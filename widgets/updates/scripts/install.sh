#!/bin/sh
# OS Update Check (Linux): installs the pending updates with sudo and reports progress in Bosun's output protocol.
# Needs passwordless sudo for the account Bosun connects with (the service account has it).
have() { command -v "$1" >/dev/null 2>&1; }

# Runs the command given as arguments and turns what it prints into protocol lines. Everything happens inside one
# pipeline, so the final DONE or ERROR line is printed from the loop that sees the command's exit code.
stream() {
  { "$@" 2>&1; echo "BOSUN_EXIT:$?"; } | {
    i=0
    pw=0
    while IFS= read -r line; do
      case "$line" in
        "Setting up "*) i=$((i + 1)); echo "PROGRESS $i/$total" ;;
        *"a password is required"*|"sudo:"*) pw=1 ;;
        BOSUN_EXIT:0)
          if [ -f /var/run/reboot-required ]; then echo "DONE Updates installed. The server needs a restart."; else echo "DONE Updates installed"; fi ;;
        BOSUN_EXIT:*)
          if [ "$pw" = 1 ]; then echo "ERROR: Passwordless sudo is required for the SSH user"; else echo "ERROR: Update failed (exit ${line#BOSUN_EXIT:})"; fi ;;
      esac
    done
  }
}

total=1
if have apt-get; then
  total=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep -c '^Inst ')
  [ "$total" -ge 1 ] || total=1
  echo "[step] Installing updates with apt"
  stream sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade
elif have dnf; then
  echo "[step] Installing updates with dnf"
  stream sudo -n dnf -y upgrade
elif have yum; then
  echo "[step] Installing updates with yum"
  stream sudo -n yum -y update
else
  echo "ERROR: No supported package manager was found (apt, dnf or yum)"
fi
exit 0
