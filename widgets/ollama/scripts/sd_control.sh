#!/bin/sh
# Ollama (Linux, systemd): starts, stops or restarts the unit (needs passwordless sudo). The unit name and the operation arrive as data.
sudo -n true 2>/dev/null || { echo 'ERROR: This account needs passwordless sudo to control the service'; exit 1; }
if ! sudo -n systemctl "$BOSUN_PARAM_op" "$BOSUN_PARAM_unit"; then echo "ERROR: Could not $BOSUN_PARAM_op the service"; exit 1; fi
# is-active exits non-zero for a stopped unit, which is the expected result of "stop": it only reports the state.
echo "DONE $BOSUN_PARAM_op: $(systemctl is-active "$BOSUN_PARAM_unit" 2>/dev/null)"
