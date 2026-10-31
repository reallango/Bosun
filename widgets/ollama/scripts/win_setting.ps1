# Ollama (Windows service): sets (or, with "default", removes) one of the managed settings of the service and restarts the
# service if it was running. nssm keeps the settings in AppEnvironmentExtra, a plain service in its Environment value; the other
# variables the service already has (OLLAMA_HOST, OLLAMA_MODELS, ...) are kept. Parameters arrive as data: manager (nssm or
# windows), name (the service), setting (OLLAMA_CONTEXT_LENGTH or OLLAMA_MAX_LOADED_MODELS), value (a whole number or "default").
$ErrorActionPreference = 'Stop'
try {
  $svc = $env:BOSUN_PARAM_name
  $name = $env:BOSUN_PARAM_setting
  $val = $env:BOSUN_PARAM_value
  if ($val -eq 'default') { $val = '' }
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $svc
  if ($env:BOSUN_PARAM_manager -eq 'nssm') {
    $wmi = Get-CimInstance Win32_Service -Filter ("Name='" + $svc + "'")
    $nssm = ($wmi.PathName -replace '^"?([^"]+?)"?(\s.*)?$', '$1')
    if (-not (Test-Path $nssm)) { throw 'nssm was not found where the service says it is' }
    $cur = @((Get-ItemProperty ($key + '\Parameters')).AppEnvironmentExtra)
    $new = @($cur | Where-Object { $_ -and ($_ -notlike ($name + '=*')) })
    if ($val -ne '') { $new += ($name + '=' + $val) }
    if ($new.Count -gt 0) { $o = & $nssm set $svc AppEnvironmentExtra @new 2>&1 } else { $o = & $nssm reset $svc AppEnvironmentExtra 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw ('nssm: ' + (($o | Out-String).Trim())) }
  } else {
    $cur = @((Get-ItemProperty $key).Environment)
    $new = @($cur | Where-Object { $_ -and ($_ -notlike ($name + '=*')) })
    if ($val -ne '') { $new += ($name + '=' + $val) }
    if ($new.Count -gt 0) { Set-ItemProperty -Path $key -Name Environment -Value $new -Type MultiString } else { Remove-ItemProperty -Path $key -Name Environment -ErrorAction SilentlyContinue }
  }
  if ((Get-Service -Name $svc).Status -eq 'Running') {
    Restart-Service -Name $svc -Force
    (Get-Service -Name $svc).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
    Write-Output ('DONE Applied and restarted: ' + $name + $(if ($val -ne '') { '=' + $val } else { ' removed' }))
  } else {
    Write-Output ('DONE Saved (the service is stopped): ' + $name)
  }
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
}
