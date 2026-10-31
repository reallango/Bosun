# Ollama (Windows): downloads a model through the local API and reports progress in Bosun's output protocol.
# The model name arrives as data ($env:BOSUN_PARAM_model) and is checked by Bosun against the parameter's pattern.
# PowerShell 5.1 mangles quotes in native-exe arguments, so the request body goes to curl.exe through a temp file.
$model = $env:BOSUN_PARAM_model
Write-Output ('[step] Pulling ' + $model)
$f = [IO.Path]::GetTempFileName()
$last = ''
try {
  [IO.File]::WriteAllText($f, ('{"name":"' + $model + '","stream":true}'))
  & curl.exe -sN -m 3500 -X POST http://127.0.0.1:11434/api/pull --data-binary ('@' + $f) | ForEach-Object {
    $line = [string]$_
    if ($line -match '"error"\s*:\s*"([^"]*)"') { Write-Output ('ERROR: ' + $Matches[1]) }
    elseif ($line -match '"status":"success"') { Write-Output 'PROGRESS 100/100'; Write-Output ('DONE Pulled ' + $model) }
    else {
      $st = ''
      if ($line -match '"status"\s*:\s*"([^"]*)"') { $st = $Matches[1] }
      $kind = $st
      foreach ($k in 'pulling', 'verifying', 'writing', 'removing', 'using') { if ($st.StartsWith($k)) { $kind = $k } }
      if ($kind -and $kind -ne $last) { Write-Output ('[step] ' + $st); $last = $kind }
      if ($line -match '"total"\s*:\s*(\d+)') {
        $total = [double]$Matches[1]
        if ($total -gt 0 -and $line -match '"completed"\s*:\s*(\d+)') { Write-Output ('PROGRESS ' + $Matches[1] + '/' + [string][int64]$total) }
      }
    }
  }
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Write-Output ('ERROR: curl exited with ' + $LASTEXITCODE + ' (is Ollama running?)') }
} finally {
  Remove-Item $f -ErrorAction SilentlyContinue
}
exit 0
