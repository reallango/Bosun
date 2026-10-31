# Hello Host (Windows): prints one JSON object. The greeting arrives as the parameter "greeting"
# ($env:BOSUN_PARAM_greeting); parameters are data and are never part of this script's text.
$hostName = $env:COMPUTERNAME
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$span = (Get-Date) - $boot
$up = '{0}d {1}h {2}m' -f $span.Days, $span.Hours, $span.Minutes
@{ message = "$($env:BOSUN_PARAM_greeting), $hostName"; uptime = $up } | ConvertTo-Json -Compress
