#!/bin/sh
# Ollama (Linux, systemd): enables or disables the unit at boot (needs passwordless sudo). Both values arrive as data.
sudo -n true 2>/dev/null || { echo 'ERROR: This account needs passwordless sudo to change the service'; exit 1; }
case "$BOSUN_PARAM_mode" in enabled) op=enable ;; *) op=disable ;; esac
if ! sudo -n systemctl "$op" "$BOSUN_PARAM_unit" >/dev/null 2>&1; then echo 'ERROR: Could not change the startup method'; exit 1; fi
echo "DONE Startup: $BOSUN_PARAM_mode"
