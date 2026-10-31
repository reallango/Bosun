#!/bin/sh
# Ollama (Linux, systemd): sets (or, with "default", removes) one of the managed settings of the unit, in a drop-in that
# sorts last so it wins over the other files, then reloads systemd and restarts the unit. The drop-in holds only Bosun's
# settings. Parameters arrive as data: unit, setting (OLLAMA_CONTEXT_LENGTH or OLLAMA_MAX_LOADED_MODELS), value (a whole
# number or "default").
unit="$BOSUN_PARAM_unit"; setting="$BOSUN_PARAM_setting"; value="$BOSUN_PARAM_value"
sudo -n true 2>/dev/null || { echo 'ERROR: This account needs passwordless sudo to change the service'; exit 1; }
dir="/etc/systemd/system/$unit.service.d"
file="$dir/zz-bosun-settings.conf"
sudo -n mkdir -p "$dir" || { echo 'ERROR: Could not create the drop-in folder'; exit 1; }
tmp=$(mktemp) || exit 1
{
  echo '[Service]'
  if sudo -n test -f "$file"; then sudo -n cat "$file" | grep '^Environment=' | grep -v "^Environment=\"$setting=" || true; fi
  if [ "$value" != default ]; then echo "Environment=\"$setting=$value\""; fi
} > "$tmp"
sudo -n install -m 0644 "$tmp" "$file" && rm -f "$tmp" || { rm -f "$tmp"; echo 'ERROR: Could not write the drop-in'; exit 1; }
sudo -n systemctl daemon-reload && sudo -n systemctl restart "$unit" || { echo 'ERROR: The service did not restart'; exit 1; }
echo "DONE Applied and restarted: $setting $([ "$value" = default ] && echo removed || echo "= $value")"
