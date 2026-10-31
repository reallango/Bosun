# OS Update Check (Windows): lists the pending Windows updates as JSON (a read-only Windows Update search).
# The search takes 15 seconds to a few minutes. "Reboot pending" comes from the registry markers that Windows Update and
# servicing set: the COM class for it (Microsoft.Update.SystemInfo) is refused for a remote (SSH) session, and a failure
# there must never cost the update list. ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$reboot = $false
try {
  $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
} catch { $reboot = $false }

$result = [ordered]@{ manager = 'windows'; updatesAvailable = 0; securityUpdates = 0; rebootRequired = [bool]$reboot; packages = @() }
try {
  $ErrorActionPreference = 'Stop'
  $wu = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  $list = @()
  foreach ($u in $wu.Updates) {
    $cats = @(foreach ($c in $u.Categories) { $c.Name })
    $kbs = @(foreach ($k in $u.KBArticleIDs) { "KB$k" })
    $kb = $kbs -join ','
    $title = [string]$u.Title
    # Most titles already end in "(KB1234567)"; only show the KB separately when the title lacks it.
    $newVersion = ''
    if ($kb -and -not $title.Contains($kb)) { $newVersion = $kb }
    $name = 'Update'
    if ($title) { $name = $title } elseif ($kb) { $name = $kb }
    # Anything Microsoft rates (MSRC severity) or files under "Security Updates" counts as security.
    $security = (($cats -join ';') -match 'security') -or ([string]$u.MsrcSeverity -ne '')
    $list += [ordered]@{ name = $name; current_version = ''; new_version = $newVersion; is_security = [bool]$security }
  }
  $result.updatesAvailable = $list.Count
  $result.securityUpdates = @($list | Where-Object { $_.is_security }).Count
  $result.packages = @($list | Select-Object -First 200)
} catch {
  $result.error = ([string]$_.Exception.Message)
  if ($result.error.Length -gt 300) { $result.error = $result.error.Substring(0, 300) }
}
$result | ConvertTo-Json -Compress -Depth 5
exit 0
