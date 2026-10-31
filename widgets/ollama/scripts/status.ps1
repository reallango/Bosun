# Ollama (Windows): the widget's data, as JSON: the version and what the API says about the models and the loaded ones.
# {"version":"0.5.1","tags":{"models":[...]},"ps":{"models":[...]}}   or   {"down":true}   when the API does not answer.
# The API answers are already JSON and are passed on as they are. ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ProgressPreference = 'SilentlyContinue'
try {
  $v = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/version).Content
  $version = ($v | ConvertFrom-Json).version
  $tags = '{"models":[]}'
  $ps = '{"models":[]}'
  try { $t = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:11434/api/tags).Content; if ($t) { $tags = $t.Trim() } } catch {}
  try { $p = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:11434/api/ps).Content; if ($p) { $ps = $p.Trim() } } catch {}
  Write-Output ('{"version":"' + $version + '","tags":' + $tags + ',"ps":' + $ps + '}')
} catch {
  Write-Output '{"down":true}'
}
exit 0
