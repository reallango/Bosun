#!/bin/sh
# Ollama (Linux, systemd service): updates Ollama on the host with the official script. Needs passwordless sudo. Whatever
# the host has configured (listen address, settings) is left alone. The release ("latest" or x.y.z) arrives as data.
version="$BOSUN_PARAM_version"
sudo -n true 2>/dev/null || { echo 'ERROR: This account needs passwordless sudo to update Ollama on the host'; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'ERROR: curl is required'; exit 1; }
echo '[step] Running the official install script'
if [ "$version" = latest ]; then
  curl -fsSL https://ollama.com/install.sh | sudo -n sh || { echo 'ERROR: The install script failed'; exit 1; }
else
  curl -fsSL https://ollama.com/install.sh | sudo -n env OLLAMA_VERSION="$version" sh || { echo 'ERROR: The install script failed'; exit 1; }
fi
i=0
while [ $i -lt 30 ]; do
  v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE Ollama $(printf '%s' "$v" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p') is running"; exit 0; }
  i=$((i + 1)); sleep 1
done
echo 'DONE Updated (the service is not answering yet)'
