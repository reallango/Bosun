# Ollama (Windows): how Ollama is installed on this host, as key=value lines (the widget's state).
#   install.kind          service | standard | none
#   service:  install.manager (nssm or windows), install.name, install.state, install.start_mode (auto, delayed, manual,
#             disabled), install.exe
#   env.ollama_context_length, env.ollama_max_loaded_models   the settings Bosun manages ('' when not set)
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$apiUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/version; $apiUp = $true } catch {}

$s = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq 'Ollama' -or $_.Name -like '*ollama*' } | Sort-Object { if ($_.Name -eq 'Ollama') { 0 } else { 1 } } | Select-Object -First 1
if ($s) {
  $nssm = ($s.PathName -match 'nssm')
  $exe = ($s.PathName -replace '^"?([^"]+?)"?(\s.*)?$', '$1')
  if ($nssm) {
    $app = (Get-ItemProperty ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $s.Name + '\Parameters') -ErrorAction SilentlyContinue).Application
    if ($app) { $exe = $app }
  }
  $envKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $s.Name
  if ($nssm) { $envList = @((Get-ItemProperty ($envKey + '\Parameters') -ErrorAction SilentlyContinue).AppEnvironmentExtra) }
  else { $envList = @((Get-ItemProperty $envKey -ErrorAction SilentlyContinue).Environment) }
  $ctx = ''; $max = ''
  foreach ($e in $envList) {
    if ($e -match '^OLLAMA_CONTEXT_LENGTH=(\d{1,9})$') { $ctx = $Matches[1] }
    if ($e -match '^OLLAMA_MAX_LOADED_MODELS=(\d{1,9})$') { $max = $Matches[1] }
  }
  $start = [string]$s.StartMode
  if ($start -eq 'Auto' -and $s.DelayedAutoStart) { $mode = 'delayed' }
  elseif ($start -eq 'Auto') { $mode = 'auto' }
  elseif ($start -eq 'Disabled') { $mode = 'disabled' }
  else { $mode = 'manual' }
  Write-Output 'install.kind=service'
  Write-Output ('install.manager=' + $(if ($nssm) { 'nssm' } else { 'windows' }))
  Write-Output ('install.name=' + $s.Name)
  Write-Output ('install.state=' + $(if ([string]$s.State -eq 'Running') { 'running' } else { 'stopped' }))
  Write-Output ('install.start_mode=' + $mode)
  Write-Output ('install.exe=' + $exe)
  Write-Output ('env.ollama_context_length=' + $ctx)
  Write-Output ('env.ollama_max_loaded_models=' + $max)
} else {
  $p = Get-Process -Name ollama -ErrorAction SilentlyContinue | Select-Object -First 1
  $std = Get-ChildItem 'C:\Users\*\AppData\Local\Programs\Ollama\ollama.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (($p -and $p.Path) -or $std -or $apiUp) { Write-Output 'install.kind=standard' } else { Write-Output 'install.kind=none' }
}
exit 0
