# Ollama (Windows service): changes how the service starts. The service name and the mode arrive as data.
$name = $env:BOSUN_PARAM_name
$types = @{ auto = 'auto'; delayed = 'delayed-auto'; manual = 'demand'; disabled = 'disabled' }
$type = $types[$env:BOSUN_PARAM_mode]
if (-not $type) { Write-Output 'ERROR: Invalid startup method'; exit 1 }
$o = & sc.exe config $name start= $type
if ($LASTEXITCODE -ne 0) { Write-Output ('ERROR: ' + ($o -join ' ')); exit 1 }
Write-Output ('DONE Startup: ' + $env:BOSUN_PARAM_mode)
