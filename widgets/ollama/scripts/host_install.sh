#!/bin/sh
# Ollama (Linux): installs Ollama on the host with the official script (it creates the systemd service). Needs passwordless
# sudo. A new install is made reachable from the network (the official script listens on localhost only) with a drop-in; the
# release ("latest" or x.y.z) arrives as data.
version="$BOSUN_PARAM_version"
sudo -n true 2>/dev/null || { echo 'ERROR: This account needs passwordless sudo to install Ollama on the host'; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'ERROR: curl is required'; exit 1; }
echo '[step] Running the official install script'
if [ "$version" = latest ]; then
  curl -fsSL https://ollama.com/install.sh | sudo -n sh || { echo 'ERROR: The install script failed'; exit 1; }
else
  curl -fsSL https://ollama.com/install.sh | sudo -n env OLLAMA_VERSION="$version" sh || { echo 'ERROR: The install script failed'; exit 1; }
fi
echo '[step] Making Ollama reachable from the network'
sudo -n mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' | sudo -n tee /etc/systemd/system/ollama.service.d/bosun-listen.conf >/dev/null
sudo -n systemctl daemon-reload && sudo -n systemctl restart ollama
i=0
while [ $i -lt 30 ]; do
  v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE Ollama $(printf '%s' "$v" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p') is running"; exit 0; }
  i=$((i + 1)); sleep 1
done
echo 'DONE Installed (the service is not answering yet)'
