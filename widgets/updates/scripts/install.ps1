# OS Update Check (Windows): installs the pending Windows updates and reports progress in Bosun's output protocol.
#
# The Windows Update Agent refuses to download or install updates when the caller is a remote session
# (E_ACCESSDENIED), and an SSH session counts as remote. The supported workaround is a one-off scheduled task under
# SYSTEM: this script writes the installer to %ProgramData%\Bosun, registers and starts the task BosunWindowsUpdate,
# then follows the installer's result file until it finishes. The host is never restarted here.
# If an install from an earlier request is still running this script follows that one. Cancelling the job in Bosun
# stops following; the task on the host carries on and can be followed again by starting the install.
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'Bosun'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$task = 'BosunWindowsUpdate'
$resultFile = Join-Path $dir 'update-result.json'

# The installer that runs on the host as SYSTEM.
$installer = @'
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'Bosun'
$out = Join-Path $dir 'update-result.json'
function Save($o) { ($o | ConvertTo-Json -Compress -Depth 4) | Set-Content -Path $out -Encoding ASCII }
function Now { (Get-Date).ToString('o') }
$started = Now
Save @{ state = 'running'; step = 'searching'; started = $started }
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  if ($found.Updates.Count -eq 0) {
    Save @{ state = 'done'; started = $started; finished = (Now); total = 0; installed = 0; failed = 0; rebootRequired = [bool]((Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')) }
    return
  }
  $all = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $found.Updates) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$all.Add($u) }
  Save @{ state = 'running'; step = 'downloading'; started = $started; total = $all.Count }
  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $all
  [void]$downloader.Download()
  $ready = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $all) { if ($u.IsDownloaded) { [void]$ready.Add($u) } }
  if ($ready.Count -eq 0) { throw 'None of the updates could be downloaded' }
  Save @{ state = 'running'; step = 'installing'; started = $started; total = $all.Count; downloaded = $ready.Count }
  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $ready
  $result = $installer.Install()
  $ok = 0
  $bad = $all.Count - $ready.Count
  for ($i = 0; $i -lt $ready.Count; $i++) {
    $rc = $result.GetUpdateResult($i).ResultCode
    if ($rc -eq 2 -or $rc -eq 3) { $ok++ } else { $bad++ }
  }
  Save @{ state = 'done'; started = $started; finished = (Now); total = $all.Count; installed = $ok; failed = $bad; rebootRequired = [bool]$result.RebootRequired; resultCode = [int]$result.ResultCode }
} catch {
  Save @{ state = 'failed'; started = $started; finished = (Now); error = [string]$_.Exception.Message }
}
'@

$existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  Write-Output '[step] An install from an earlier request is still running; following it'
} else {
  $script = Join-Path $dir 'update-install.ps1'
  [System.IO.File]::WriteAllBytes($script, [System.Text.Encoding]::UTF8.GetBytes($installer))
  Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"')
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Write-Output '[step] Install started on the host'
}

$labels = @{ searching = 'Searching for updates'; downloading = 'Downloading updates'; installing = 'Installing updates' }
$percent = @{ searching = 10; downloading = 40; installing = 70 }
$lastStep = ''
$deadline = (Get-Date).AddMinutes(55)
$ErrorActionPreference = 'SilentlyContinue'
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 4
  $t = Get-ScheduledTask -TaskName $task
  $state = 'None'
  if ($t) { $state = [string]$t.State }
  $r = $null
  if (Test-Path $resultFile) { $r = (Get-Content -Raw $resultFile) | ConvertFrom-Json }
  if ($state -eq 'Running') {
    if ($r -and $r.state -eq 'running' -and $r.step -and $r.step -ne $lastStep) {
      $lastStep = [string]$r.step
      Write-Output ('[step] ' + $labels[$lastStep])
      Write-Output ('PROGRESS ' + $percent[$lastStep] + '/100')
    }
    continue
  }
  # The task is not running any more: read the outcome and clean up.
  if ($t) { Unregister-ScheduledTask -TaskName $task -Confirm:$false }
  if ($r -and $r.state -eq 'done') {
    $installed = [int]$r.installed; $failed = [int]$r.failed; $total = [int]$r.total
    if ($total -eq 0) { $msg = 'No updates were pending' } else { $msg = "Installed $installed of $total updates" }
    if ($failed -gt 0) { $msg += "; $failed failed" }
    if ($r.rebootRequired) { $msg += '; a restart is needed to finish' }
    if ($total -gt 0 -and $installed -eq 0) { Write-Output ('ERROR: ' + $msg) } else { Write-Output ('PROGRESS 100/100'); Write-Output ('DONE ' + $msg) }
  } elseif ($r -and $r.state -eq 'failed') {
    Write-Output ('ERROR: Windows Update install failed: ' + ([string]$r.error))
  } else {
    Write-Output 'ERROR: The install stopped before it finished (the host may have restarted). Check again, then retry.'
  }
  exit 0
}
Write-Output 'ERROR: Still installing after 55 minutes. The install carries on on the host; start the install again to follow it.'
exit 0
