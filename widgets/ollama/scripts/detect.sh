#!/bin/sh
# Ollama (Linux): how Ollama is installed on this host, as key=value lines (the widget's state).
#   install.kind          docker | service | standard | none
#   install.docker_available   whether Docker can be used by this account (to install Ollama as a container)
#   docker:   install.container, install.image, install.state, install.restart_policy
#   service:  install.manager (systemd), install.name, install.state, install.start_mode
#   env.ollama_context_length, env.ollama_max_loaded_models   the settings Bosun manages ('' when not set)
have() { command -v "$1" >/dev/null 2>&1; }
api_up=0
if have curl && [ -n "$(curl -s -m 3 http://127.0.0.1:11434/api/version 2>/dev/null)" ]; then api_up=1; fi

docker_available=0
dk_name=''; dk_state=''; dk_restart=''; dk_image=''; dk_ctx=''; dk_max=''
if have docker; then
  docker_available=1
  D=docker; docker ps >/dev/null 2>&1 || { have sudo && sudo -n docker ps >/dev/null 2>&1 && D='sudo -n docker'; }
  c=$($D ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /(^|\/)ollama\/ollama/ {print $1; exit}')
  if [ -n "$c" ]; then
    dk_name=$c
    dk_state=$($D inspect -f '{{.State.Status}}' "$c" 2>/dev/null)
    dk_restart=$($D inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null)
    dk_image=$($D inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)
    envs=$($D inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null)
    dk_ctx=$(printf '%s\n' "$envs" | sed -n 's/^OLLAMA_CONTEXT_LENGTH=//p' | head -n 1)
    dk_max=$(printf '%s\n' "$envs" | sed -n 's/^OLLAMA_MAX_LOADED_MODELS=//p' | head -n 1)
  fi
fi

host_bin=''
have ollama && host_bin=$(command -v ollama)
unit=''; unit_active=''; unit_enabled=''; unit_ctx=''; unit_max=''
if have systemctl && [ "$(systemctl show -p LoadState --value ollama.service 2>/dev/null)" = loaded ]; then
  unit=ollama
  unit_active=$(systemctl is-active ollama 2>/dev/null)
  unit_enabled=$(systemctl is-enabled ollama 2>/dev/null)
  senv=$(systemctl show ollama -p Environment 2>/dev/null | tr ' ' '\n' | tr -d '"' | sed 's/^Environment=//')
  unit_ctx=$(printf '%s\n' "$senv" | sed -n 's/^OLLAMA_CONTEXT_LENGTH=//p' | head -n 1)
  unit_max=$(printf '%s\n' "$senv" | sed -n 's/^OLLAMA_MAX_LOADED_MODELS=//p' | head -n 1)
fi

# Only whole numbers are passed on.
num() { case "$1" in ''|*[!0-9]*) echo '' ;; *) [ ${#1} -le 9 ] && echo "$1" || echo '' ;; esac; }

echo "install.docker_available=$([ "$docker_available" = 1 ] && echo true || echo false)"
if [ -n "$dk_name" ] && ! { [ -n "$unit" ] && [ "$unit_active" = active ] && [ "$dk_state" != running ]; }; then
  echo 'install.kind=docker'
  echo "install.container=$dk_name"
  echo "install.image=$dk_image"
  echo "install.state=${dk_state:-unknown}"
  echo "install.restart_policy=${dk_restart:-no}"
  echo "env.ollama_context_length=$(num "$dk_ctx")"
  echo "env.ollama_max_loaded_models=$(num "$dk_max")"
elif [ -n "$unit" ]; then
  echo 'install.kind=service'
  echo 'install.manager=systemd'
  echo "install.name=$unit"
  case "$unit_active" in active) echo 'install.state=running' ;; failed) echo 'install.state=failed' ;; *) echo 'install.state=stopped' ;; esac
  case "$unit_enabled" in enabled|disabled) echo "install.start_mode=$unit_enabled" ;; *) echo "install.start_mode=${unit_enabled:-unknown}" ;; esac
  echo "env.ollama_context_length=$(num "$unit_ctx")"
  echo "env.ollama_max_loaded_models=$(num "$unit_max")"
elif [ -n "$host_bin" ] || [ "$api_up" = 1 ]; then
  echo 'install.kind=standard'
else
  echo 'install.kind=none'
fi
exit 0
