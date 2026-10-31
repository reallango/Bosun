#!/bin/sh
# Ollama (Linux): downloads a model through the local API and reports progress in Bosun's output protocol.
# The model name arrives as data (BOSUN_PARAM_model) and is checked by Bosun against the parameter's pattern.
model="$BOSUN_PARAM_model"
command -v curl >/dev/null 2>&1 || { echo 'ERROR: curl is not installed on this host'; exit 0; }
echo "[step] Pulling $model"
body=$(printf '{"name":"%s","stream":true}' "$model")
last=''
curl -sN -m 3500 -X POST http://127.0.0.1:11434/api/pull --data-binary "$body" 2>&1 | while IFS= read -r line; do
  case "$line" in
    *'"error"'*)
      msg=$(printf '%s' "$line" | sed -n 's/.*"error" *: *"\([^"]*\)".*/\1/p')
      echo "ERROR: ${msg:-The pull failed}" ;;
    *'"status":"success"'*) echo 'PROGRESS 100/100'; echo "DONE Pulled $model" ;;
    *)
      st=$(printf '%s' "$line" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p')
      # Layer names change often ("pulling 3f2a..."); only a change of kind is a step.
      case "$st" in pulling*) kind=pulling ;; verifying*) kind=verifying ;; writing*) kind=writing ;; removing*) kind=removing ;; using*) kind=using ;; *) kind=$st ;; esac
      if [ -n "$kind" ] && [ "$kind" != "$last" ]; then echo "[step] $st"; last=$kind; fi
      total=$(printf '%s' "$line" | sed -n 's/.*"total" *: *\([0-9][0-9]*\).*/\1/p')
      completed=$(printf '%s' "$line" | sed -n 's/.*"completed" *: *\([0-9][0-9]*\).*/\1/p')
      if [ -n "$total" ] && [ -n "$completed" ] && [ "$total" -gt 0 ]; then echo "PROGRESS $completed/$total"; fi ;;
  esac
done
exit 0
