#!/bin/sh
# Hello Host (Linux): prints one JSON object. The greeting arrives as the parameter "greeting"
# (BOSUN_PARAM_greeting); parameters are data and are never part of this script's text.
host=$(hostname)
up=$(uptime -p 2>/dev/null || uptime)
printf '{"message":"%s, %s","uptime":"%s"}\n' "$BOSUN_PARAM_greeting" "$host" "$up"
