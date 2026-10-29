/**
 * Installing Windows updates over SSH.
 *
 * The Windows Update Agent refuses to download or install updates when the caller
 * is a remote session (E_ACCESSDENIED), and an SSH session counts as remote. The
 * supported workaround is to run the install as a one-off scheduled task under
 * SYSTEM. So Bosun:
 *   1. writes the install script to %ProgramData%\Bosun and registers + starts the
 *      task `BosunWindowsUpdate` (startScript),
 *   2. returns at once (an install can take a long time), and
 *   3. reads progress from %ProgramData%\Bosun\update-result.json (statusScript).
 * The host is never rebooted here; the result says when a reboot is needed.
 *
 * Pure strings and parsing only (no imports) so it can be unit tested.
 */

export const TASK_NAME = 'BosunWindowsUpdate';

/** Runs on the host as SYSTEM. ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI. */
export const INSTALL_SCRIPT = String.raw`
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
`.trim();

/**
 * Run over SSH as the service account (an administrator): write the install script,
 * register the SYSTEM task and start it. Prints BOSUN_STARTED, or BOSUN_ALREADY_RUNNING
 * when an install from an earlier request is still going.
 */
export function startScript(): string {
  const b64 = Buffer.from(INSTALL_SCRIPT, 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'Bosun'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$task = '` + TASK_NAME + String.raw`'
$existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  Write-Output 'BOSUN_ALREADY_RUNNING'
} else {
  $script = Join-Path $dir 'update-install.ps1'
  [System.IO.File]::WriteAllBytes($script, [Convert]::FromBase64String('` + b64 + String.raw`'))
  Remove-Item (Join-Path $dir 'update-result.json') -Force -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"')
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  Write-Output 'BOSUN_STARTED'
}
`.trim();
}

/**
 * Run over SSH: report the task state and the installer's result file. Also removes
 * the finished task so nothing is left registered (the result file stays readable
 * until the next install).
 */
export function statusScript(): string {
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$f = Join-Path (Join-Path $env:ProgramData 'Bosun') 'update-result.json'
$t = Get-ScheduledTask -TaskName '` + TASK_NAME + String.raw`'
$state = if ($t) { [string]$t.State } else { 'None' }
$json = if (Test-Path $f) { (Get-Content -Raw $f) -replace '[\r\n]+', ' ' } else { '' }
Write-Output ('BOSUN_TASK ' + $state)
Write-Output ('BOSUN_RESULT ' + $json.Trim())
if ($t -and $state -ne 'Running') { Unregister-ScheduledTask -TaskName '` + TASK_NAME + String.raw`' -Confirm:$false }
`.trim();
}

export type InstallState = 'idle' | 'running' | 'done' | 'failed';

export interface WindowsInstallStatus {
  state: InstallState;
  /** searching | downloading | installing while running. */
  step?: string;
  total?: number;
  installed?: number;
  failed?: number;
  rebootRequired?: boolean;
  /** Human-readable summary for the widget. */
  message: string;
}

const STEP_LABEL: Record<string, string> = {
  searching: 'Searching for updates',
  downloading: 'Downloading updates',
  installing: 'Installing updates',
};

/** Interpret statusScript() output. Never throws. */
export function parseInstallStatus(stdout: string): WindowsInstallStatus {
  const task = (stdout.match(/^BOSUN_TASK (.*)$/m)?.[1] ?? '').trim();
  const raw = (stdout.match(/^BOSUN_RESULT (.*)$/m)?.[1] ?? '').trim();
  let r: Record<string, unknown> = {};
  try { if (raw) r = JSON.parse(raw); } catch { /* unreadable: treated as no result */ }
  const taskRunning = task === 'Running';
  const state = typeof r.state === 'string' ? r.state : '';

  if (state === 'running' && taskRunning) {
    const step = typeof r.step === 'string' ? r.step : undefined;
    return { state: 'running', step, total: Number(r.total) || undefined, message: `${STEP_LABEL[step ?? ''] ?? 'Working'}…` };
  }
  if (taskRunning) return { state: 'running', message: 'Starting…' };
  if (state === 'done') {
    const installed = Number(r.installed) || 0;
    const failed = Number(r.failed) || 0;
    const total = Number(r.total) || 0;
    const rebootRequired = !!r.rebootRequired;
    const parts = total === 0 ? ['No updates were pending'] : [`Installed ${installed} of ${total} update${total === 1 ? '' : 's'}`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (rebootRequired) parts.push('a restart is needed to finish');
    return { state: 'done', installed, failed, total, rebootRequired, message: parts.join('; ') };
  }
  if (state === 'failed') {
    return { state: 'failed', message: `Windows Update install failed: ${String(r.error || 'unknown error').slice(0, 300)}` };
  }
  // The result says "running" but the task is gone or stopped: it was killed (reboot, time limit).
  if (state === 'running') return { state: 'failed', message: 'The install stopped before it finished (the host may have restarted). Check again, then retry.' };
  return { state: 'idle', message: 'No install in progress' };
}
