# Custom Command (Windows): runs the command that arrives as the parameter "command" and prints what it printed.
# The command is data ($env:BOSUN_PARAM_command), never part of this script's text. It runs as the account Bosun
# connects with for this widget (the host's non-admin shell account).
# Exit code is reported in the output; the script itself always succeeds so the output is shown.
$cmd = $env:BOSUN_PARAM_command
if ([string]::IsNullOrWhiteSpace($cmd) -or $cmd.Trim() -eq 'uptime') {
  # `uptime` does not exist in PowerShell, so the untouched default means this. It must work for a standard user:
  # WMI/CIM and `net statistics workstation` are refused to a non-admin remote logon. The high resolution timer
  # counts from boot and needs no rights.
  $s = [Diagnostics.Stopwatch]::GetTimestamp() / [Diagnostics.Stopwatch]::Frequency
  $t = [TimeSpan]::FromSeconds($s)
  Write-Output ("up {0} days, {1:00}:{2:00}" -f $t.Days, $t.Hours, $t.Minutes)
  exit 0
}
$global:LASTEXITCODE = $null
try {
  $out = Invoke-Expression $cmd 2>&1 | Out-String
} catch {
  $out = $_.Exception.Message
}
Write-Output $out.TrimEnd()
if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {
  Write-Output ("(the command exited with code {0})" -f $global:LASTEXITCODE)
}
exit 0
