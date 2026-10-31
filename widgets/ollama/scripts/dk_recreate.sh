#!/bin/sh
# Ollama (Linux, container): recreates the container from its own settings, to run a newer image or to change one of the
# settings Bosun manages. Parameters arrive as data:
#   container  the container
#   version    keep (same image, nothing is pulled) | latest | x.y.z (same repository, that tag, pulled first)
#   setting    none | OLLAMA_CONTEXT_LENGTH | OLLAMA_MAX_LOADED_MODELS
#   value      a whole number, or "default" to remove the setting
# The new container gets the old one's name, published ports, volumes and bind mounts, Ollama and NVIDIA environment, GPU
# access, restart policy and network. A container that belongs to a Compose project is refused (update those with Compose).
# The old container is only removed once the new one runs; if the new one cannot start, the old one is put back.
c="$BOSUN_PARAM_container"; version="$BOSUN_PARAM_version"; setting="$BOSUN_PARAM_setting"; value="$BOSUN_PARAM_value"
D=docker; $D ps >/dev/null 2>&1 || { command -v sudo >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
$D ps >/dev/null 2>&1 || { echo 'ERROR: Docker is not available to this account'; exit 1; }
$D inspect "$c" >/dev/null 2>&1 || { echo 'ERROR: The container was not found'; exit 1; }
insp() { $D inspect -f "$1" "$c" 2>/dev/null; }

[ -z "$(insp '{{index .Config.Labels "com.docker.compose.project"}}')" ] || { echo 'ERROR: This container is managed by Docker Compose; update it with Compose'; exit 1; }

cur_image=$(insp '{{.Config.Image}}')
if [ "$version" = keep ]; then
  image=$cur_image; pull=0
else
  repo=$(printf '%s' "$cur_image" | sed 's/:[^:/]*$//')
  [ -n "$repo" ] || repo=ollama/ollama
  image="$repo:$version"; pull=1
fi
[ "$pull" = 0 ] || { echo "[step] Pulling $image"; $D pull "$image" || { echo 'ERROR: Could not pull the image'; exit 1; }; }

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
set -- run -d --name "$c"

rp=$(insp '{{.HostConfig.RestartPolicy.Name}}'); mr=$(insp '{{.HostConfig.RestartPolicy.MaximumRetryCount}}')
case "$rp" in
  always|unless-stopped) set -- "$@" --restart "$rp" ;;
  on-failure) if [ "${mr:-0}" -gt 0 ] 2>/dev/null; then set -- "$@" --restart "on-failure:$mr"; else set -- "$@" --restart on-failure; fi ;;
esac

net=$(insp '{{.HostConfig.NetworkMode}}')
case "$net" in
  host) set -- "$@" --network host ;;
  default|bridge|'') ;;
  *) if printf '%s' "$net" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$'; then set -- "$@" --network "$net"; fi ;;
esac

if [ "$net" != host ]; then
  insp '{{range $p, $bs := .HostConfig.PortBindings}}{{range $bs}}{{.HostIp}}|{{.HostPort}}|{{$p}}{{"\n"}}{{end}}{{end}}' > "$tmp"
  while IFS='|' read -r ip hp port; do
    [ -n "$port" ] || continue
    printf '%s' "$port" | grep -Eq '^[0-9]{1,5}/(tcp|udp)$' || { echo 'ERROR: Unexpected port mapping'; exit 1; }
    printf '%s' "$hp" | grep -Eq '^[0-9]{0,5}$' || { echo 'ERROR: Unexpected port mapping'; exit 1; }
    pre=''
    if [ -n "$ip" ] && [ "$ip" != 0.0.0.0 ] && printf '%s' "$ip" | grep -Eq '^[0-9a-fA-F:.]+$'; then
      case "$ip" in *:*) pre="[$ip]:" ;; *) pre="$ip:" ;; esac
    fi
    set -- "$@" -p "$pre$hp:$port"
  done < "$tmp"
fi

insp '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{"\n"}}{{end}}' > "$tmp"
while IFS='|' read -r mtype mname msrc mdst mrw; do
  case "$mdst" in /*) ;; *) continue ;; esac
  case "$mtype" in volume) src=$mname ;; bind) src=$msrc ;; *) continue ;; esac
  [ -n "$src" ] || continue
  if [ "$mrw" = false ]; then set -- "$@" -v "$src:$mdst:ro"; else set -- "$@" -v "$src:$mdst"; fi
done < "$tmp"

insp '{{range .Config.Env}}{{println .}}{{end}}' > "$tmp"
while IFS= read -r e; do
  case "$e" in
    OLLAMA_[A-Z0-9_]*=*|NVIDIA_[A-Z0-9_]*=*|CUDA_VISIBLE_DEVICES=*)
      name=${e%%=*}
      [ "$name" = "$setting" ] && continue   # replaced (or removed) below
      set -- "$@" -e "$e" ;;
  esac
done < "$tmp"
if [ "$setting" != none ] && [ "$value" != default ]; then set -- "$@" -e "$setting=$value"; fi

insp '{{range .HostConfig.DeviceRequests}}{{.Count}}|{{range .DeviceIDs}}{{.}},{{end}}|{{.Capabilities}}{{"\n"}}{{end}}' > "$tmp"
while IFS='|' read -r gcount gids gcaps; do
  case "$gcaps" in *gpu*) ;; *) continue ;; esac
  if [ -n "$gids" ]; then set -- "$@" --gpus "\"device=${gids%,}\""
  elif [ "${gcount:-0}" -gt 0 ] 2>/dev/null; then set -- "$@" --gpus "$gcount"
  else set -- "$@" --gpus all; fi
done < "$tmp"

set -- "$@" "$image"
old="$c-bosun-old"
echo '[step] Replacing the container'
$D rm -f "$old" >/dev/null 2>&1
$D stop "$c" >/dev/null && $D rename "$c" "$old" || { echo 'ERROR: Could not stop the container'; exit 1; }
if $D "$@" >/dev/null; then
  $D rm "$old" >/dev/null
  i=0
  while [ $i -lt 30 ]; do
    v=$(curl -s -m 2 http://127.0.0.1:11434/api/version) && [ -n "$v" ] && { echo "DONE Ollama $(printf '%s' "$v" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p') is running"; exit 0; }
    i=$((i + 1)); sleep 1
  done
  echo 'DONE The container runs (the API is not answering yet)'
  exit 0
else
  echo 'ERROR: The new container failed to start; the old one was put back'
  $D rename "$old" "$c" && $D start "$c" >/dev/null
  exit 1
fi
