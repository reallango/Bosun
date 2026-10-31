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
# Like `ollama ps`: each loaded model also gets "processor" (its share on CPU and GPU) and "id" (the first 12 characters of its digest).
ps=$(printf '%s' "$ps" | awk '{
  s = $0; out = ""; marker = "{\"name\":"
  while ((i = index(s, marker)) > 0) {
    out = out substr(s, 1, i - 1); s = substr(s, i)
    j = index(substr(s, 2), marker)
    if (j > 0) { seg = substr(s, 1, j); s = substr(s, j + 1) } else { seg = s; s = "" }
    size = 0; vram = 0; id = ""
    if (match(seg, /"size":[0-9]+/)) size = substr(seg, RSTART + 7, RLENGTH - 7) + 0
    if (match(seg, /"size_vram":[0-9]+/)) vram = substr(seg, RSTART + 12, RLENGTH - 12) + 0
    if (match(seg, /"digest":"[0-9a-f]+/)) id = substr(seg, RSTART + 10, 12)
    if (size <= 0) proc = ""
    else if (vram >= size) proc = "100% GPU"
    else if (vram <= 0) proc = "100% CPU"
    else { cpu = int((size - vram) * 100 / size + 0.5); proc = cpu "%/" (100 - cpu) "% CPU/GPU" }
    out = out "{\"processor\":\"" proc "\",\"id\":\"" id "\"," substr(seg, 2)
  }
  print out s
}')
printf '{"version":"%s","tags":%s,"ps":%s}\n' "$version" "$tags" "$ps"
exit 0
