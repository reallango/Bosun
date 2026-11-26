#!/bin/bash
set -e

# Create a monitoring-only service account for Bosun on Ubuntu/Debian.
#
# Prefer Settings > Servers > Add (Provision) in Bosun: it creates the service account itself. That
# account is an administrator by design (passwordless sudo and the docker group), because Bosun's
# power, update, service and Docker actions need it.
#
# This script makes a *limited* account instead, for hosts Bosun should only watch. It is limited for
# real: no docker group (membership is the same as root), and sudo only for commands that cannot be
# turned into a root shell. Not granted on purpose, because each of them is root-equivalent: cat
# (reads /etc/shadow and keys), curl (writes any file), apt/dpkg (install anything), docker, and
# systemctl with wildcards (enable a unit file from anywhere, pagers).
# Docker, package updates and service control widgets will not work with this account.
echo "=== Bosun Service Account Setup (monitoring only) ==="

ACCOUNT=svc-bosun

# Create user if not exists
if ! id "$ACCOUNT" &>/dev/null; then
    echo "Creating user '$ACCOUNT'..."
    useradd -m -s /bin/bash "$ACCOUNT"
    passwd -l "$ACCOUNT" >/dev/null
else
    echo "User '$ACCOUNT' already exists."
fi

# .ssh directory for the key Bosun gives you (Settings > SSH keys: generate one, paste its public key here).
install -d -m 700 -o "$ACCOUNT" -g "$ACCOUNT" "/home/$ACCOUNT/.ssh"
touch "/home/$ACCOUNT/.ssh/authorized_keys"
chown "$ACCOUNT:$ACCOUNT" "/home/$ACCOUNT/.ssh/authorized_keys"
chmod 600 "/home/$ACCOUNT/.ssh/authorized_keys"

# Narrow sudo: power actions and hardware details only (exact arguments, no wildcards).
SUDOERS_FILE="/etc/sudoers.d/$ACCOUNT"
echo "Configuring sudoers at ${SUDOERS_FILE}..."
tmp=$(mktemp)
cat > "$tmp" << SUDOERS
$ACCOUNT ALL=(root) NOPASSWD: /sbin/reboot, /sbin/shutdown -h now, /sbin/shutdown -r now, /usr/bin/lshw -json, /usr/bin/nvidia-smi
SUDOERS
visudo -cf "$tmp" >/dev/null
install -m 440 -o root -g root "$tmp" "$SUDOERS_FILE"
rm -f "$tmp"

echo "=== Setup Complete ==="
echo "Add Bosun's public key to /home/$ACCOUNT/.ssh/authorized_keys, then add this host in Bosun with user $ACCOUNT."
