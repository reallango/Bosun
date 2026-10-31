#!/bin/sh
# Ollama (Linux): the widget's data, as JSON: the version and what the API says about the models and the loaded ones.
# {"version":"0.5.1","tags":{"models":[...]},"ps":{"models":[...]}}   or   {"down":true}   when the API does not answer.
# The API answers are already JSON and are passed on as they are.
if ! command -v curl >/dev/null 2>&1; then echo '{"down":true,"reason":"curl is not installed"}'; exit 0; fi
v=$(curl -s -m 3 http://127.0.0.1:11434/api/version 2>/dev/null)
version=$(printf '%s' "$v" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')
if [ -z "$version" ]; then echo '{"down":true}'; exit 0; fi
tags=$(curl -s -m 5 http://127.0.0.1:11434/api/tags 2>/dev/null)
ps=$(curl -s -m 3 http://127.0.0.1:11434/api/ps 2>/dev/null)
[ -n "$tags" ] || tags='{"models":[]}'
[ -n "$ps" ] || ps='{"models":[]}'
printf '{"version":"%s","tags":%s,"ps":%s}\n' "$version" "$tags" "$ps"
exit 0
