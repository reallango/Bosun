#!/bin/bash
set -e

# Create service account for Bosun on Ubuntu/Debian
echo "=== Bosun Service Account Setup ==="
echo "This script creates a svc-bosun user with limited sudo access."

# Create user if not exists
if ! id svc-bosun &>/dev/null; then
    echo "Creating user 'svc-bosun'..."
    useradd -m -s /bin/bash svc-bosun
else
    echo "User 'svc-bosun' already exists."
fi

# Create .ssh directory
mkdir -p /home/svc-bosun/.ssh
chown svc-bosun:svc-bosun /home/svc-bosun/.ssh
chmod 700 /home/svc-bosun/.ssh

# Generate SSH key if not exists
if [ ! -f /home/svc-bosun/.ssh/id_bosun ]; then
    echo "Generating Ed25519 SSH key..."
    ssh-keygen -t ed25519 -f /home/svc-bosun/.ssh/id_bosun -C "bosun-managed" -N ""
    chown svc-bosun:svc-bosun /home/svc-bosun/.ssh/id_bosun
    chown svc-bosun:svc-bosun /home/svc-bosun/.ssh/id_bosun.pub
fi

# Configure sudoers file
SUDOERS_FILE="/etc/sudoers.d/svc-bosun"
echo "Configuring sudoers at ${SUDOERS_FILE}..."
cat > "${SUDOERS_FILE}" << 'SUDOERS'
svc-bosun ALL=(root) NOPASSWD: /bin/cat, /usr/bin/uname, /usr/bin/uptime, /bin/hostname, /usr/bin/free, /bin/df, /usr/bin/lscpu, /usr/bin/lshw, /usr/bin/top, /bin/ip, /usr/bin/ss, /usr/bin/apt, /usr/bin/dpkg, /sbin/reboot, /sbin/shutdown, /bin/systemctl, /usr/bin/docker, /usr/bin/docker compose, /usr/bin/nvidia-smi, /usr/bin/curl

# Allow systemctl for specific actions only
svc-bosun ALL=(root) NOPASSWD: /bin/systemctl status *.service, /bin/systemctl start *.service, /bin/systemctl stop *.service, /bin/systemctl restart *.service, /bin/systemctl enable *.service, /bin/systemctl disable *.service, /bin/systemctl list-units *.service
SUDOERS

chmod 440 "${SUDOERS_FILE}"

echo "=== Setup Complete ==="
echo "SSH public key for svc-bosun:"
cat /home/svc-bosun/.ssh/id_bosun.pub
echo ""
echo "Add this key to Bosun and test connection."