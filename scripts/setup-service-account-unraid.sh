#!/bin/bash
set -e

# Setup script for Unraid OS
echo "=== Bosun Service Account Setup for Unraid ==="
echo "NOTE: On Unraid, users are managed via the WebGUI."
echo ""
echo "To configure Bosun on Unraid:"
echo "1. Go to Users > Add User"
echo "2. Create user: svc-bosun"
echo "3. Assign to groups: users"
echo ""
echo "For SSH key setup, SSH to Unraid and run:"
echo "  mkdir -p /boot/config/sshkeys/svc-bosun"
echo "  ssh-keygen -t ed25519 -f /boot/config/sshkeys/svc-bosun/id_ed25519"
echo "  chown svc-bosun:users /boot/config/sshkeys/svc-bosun/id_ed25519"
echo ""
echo "Then copy the public key to Bosun's SSH key management."
echo ""
echo "Limited sudo access can be configured via /etc/sudoers.d/svc-bosun:"
cat << 'SUDOERS'
svc-bosun ALL=(root) NOPASSWD: /sbin/reboot, /usr/bin/docker, /usr/bin/docker compose, /usr/bin/cat, /usr/bin/df, /usr/bin/free, /usr/bin/uptime, /usr/bin/nvidia-smi
SUDOERS