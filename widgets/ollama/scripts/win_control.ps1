# Ollama (Windows service): starts, stops or restarts the service. The service name and the operation arrive as data.
$ErrorActionPreference = 'Stop'
$name = $env:BOSUN_PARAM_name
try {
  switch ($env:BOSUN_PARAM_op) {
    'start' { Start-Service -Name $name }
    'stop' { Stop-Service -Name $name -Force }
    'restart' { Restart-Service -Name $name -Force }
  }
  Write-Output ('DONE ' + $env:BOSUN_PARAM_op + ': ' + (Get-Service -Name $name).Status)
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
}
