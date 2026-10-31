#!/bin/sh
# Ollama (Linux): runs Ollama as a Docker container named "ollama" (the default on Linux). It listens on port 11434 of the
# host and keeps its models in the volume "ollama". The release ("latest" or x.y.z) arrives as data.
version="$BOSUN_PARAM_version"
image="ollama/ollama:$version"
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
if $D ps -a --format '{{.Names}}' | grep -qx ollama; then echo 'ERROR: A container named ollama already exists'; exit 1; fi
GPU=''; $D info 2>/dev/null | grep -qi nvidia && GPU='--gpus=all'
echo "[step] Pulling $image"
$D pull "$image" || { echo 'ERROR: Could not pull the image'; exit 1; }
echo '[step] Starting the container'
$D run -d --name ollama --restart unless-stopped $GPU -p 11434:11434 -v ollama:/root/.ollama "$image" >/dev/null || { echo 'ERROR: The container did not start'; exit 1; }
i=0
while [ $i -lt 30 ]; do
  v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE Ollama $(printf '%s' "$v" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p') is running"; exit 0; }
  i=$((i + 1)); sleep 1
done
echo 'ERROR: The container started but the API did not answer'
exit 1
