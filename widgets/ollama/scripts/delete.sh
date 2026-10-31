#!/bin/sh
# Ollama (Linux): removes a model through the local API. The model name arrives as data (BOSUN_PARAM_model).
model="$BOSUN_PARAM_model"
command -v curl >/dev/null 2>&1 || { echo 'ERROR: curl is not installed on this host'; exit 1; }
body=$(printf '{"name":"%s"}' "$model")
out=$(curl -s -w '\nHTTP_STATUS=%{http_code}\n' -X DELETE http://127.0.0.1:11434/api/delete --data-binary "$body")
status=$(printf '%s\n' "$out" | sed -n 's/^HTTP_STATUS=//p')
if [ "$status" = 200 ]; then echo "DONE Deleted $model"; exit 0; fi
if [ -z "$status" ] || [ "$status" = 000 ]; then echo 'ERROR: The Ollama API is not reachable on the host (is it running?)'; exit 1; fi
msg=$(printf '%s\n' "$out" | sed -n 's/.*"error" *: *"\([^"]*\)".*/\1/p' | head -n 1)
echo "ERROR: ${msg:-HTTP $status}"
exit 1
