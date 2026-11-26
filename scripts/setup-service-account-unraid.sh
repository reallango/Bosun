#!/bin/bash
set -e

# Setup notes for Unraid OS (prints instructions only).
echo "=== Bosun Service Account Setup for Unraid ==="
echo "NOTE: On Unraid, users are managed via the WebGUI."
echo ""
echo "To configure Bosun on Unraid:"
echo "1. Go to Users > Add User"
echo "2. Create user: svc-bosun"
echo "3. Assign to groups: users"
echo ""
echo "For SSH key setup, generate a key in Bosun (Settings > SSH keys) and add its public key to"
echo "the account's authorized_keys on Unraid."
echo ""
echo "Limited sudo access (monitoring and power only) can be configured via /etc/sudoers.d/svc-bosun."
echo "Do not add docker, cat, curl or package tools there: each of them is the same as full root."
cat << 'SUDOERS'
svc-bosun ALL=(root) NOPASSWD: /sbin/reboot, /sbin/shutdown -h now, /sbin/shutdown -r now, /usr/bin/nvidia-smi
SUDOERS
