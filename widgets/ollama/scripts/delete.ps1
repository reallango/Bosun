# Ollama (Windows): removes a model through the local API. The model name arrives as data ($env:BOSUN_PARAM_model).
# PowerShell 5.1 mangles quotes in native-exe arguments, so the request body goes to curl.exe through a temp file.
$model = $env:BOSUN_PARAM_model
$f = [IO.Path]::GetTempFileName()
try {
  [IO.File]::WriteAllText($f, ('{"name":"' + $model + '"}'))
  $out = (& curl.exe -s -w "`nHTTP_STATUS=%{http_code}`n" -X DELETE http://127.0.0.1:11434/api/delete --data-binary ('@' + $f) | Out-String)
} finally {
  Remove-Item $f -ErrorAction SilentlyContinue
}
$status = ''
if ($out -match 'HTTP_STATUS=(\d+)') { $status = $Matches[1] }
if ($status -eq '200') { Write-Output ('DONE Deleted ' + $model); exit 0 }
if (-not $status -or $status -eq '000') { Write-Output 'ERROR: The Ollama API is not reachable on the host (is it running?)'; exit 1 }
$msg = ''
if ($out -match '"error"\s*:\s*"([^"]*)"') { $msg = $Matches[1] }
if (-not $msg) { $msg = 'HTTP ' + $status }
Write-Output ('ERROR: ' + $msg)
exit 1
