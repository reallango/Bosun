#!/bin/sh
# Custom Command (Linux): runs the command that arrives as the parameter "command" and prints what it printed.
# The command is data (BOSUN_PARAM_command), never part of this script's text. It runs as the account Bosun
# connects with for this widget (the host's non-admin shell account).
# Exit code and timeout are reported in the output; the script itself always succeeds so the output is shown.
limit=20
if command -v timeout >/dev/null 2>&1; then
  out=$(timeout "$limit" sh -c "$BOSUN_PARAM_command" 2>&1)
else
  out=$(sh -c "$BOSUN_PARAM_command" 2>&1)
fi
code=$?
printf '%s\n' "$out"
if [ "$code" -eq 124 ]; then
  printf '(the command timed out after %s s)\n' "$limit"
elif [ "$code" -ne 0 ]; then
  printf '(the command exited with code %s)\n' "$code"
fi
exit 0
