/** Quote a value as a PowerShell single-quoted string literal. */
function psLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell that removes earlier Bosun keys from the Windows host's
 * administrators_authorized_keys, which every administrator shares, so this is
 * deliberately stricter than the Linux version:
 *
 * - a line is removed only when its comment is exactly `label`
 *   (`<host>-<account>`, how Bosun labels the key it generates for this host);
 * - other keys ending in `-<account>` but with a different host label are left
 *   alone and counted (BOSUN_LOOKALIKE=n) so the caller can say so;
 * - the new key's line is never removed, and nothing is touched if it is not
 *   in the file;
 * - the file is edited in place (permissions untouched) after a backup copy
 *   (`.bosun-bak`) and re-read afterwards; the backup is restored if the new key
 *   is not found.
 *
 * Prints BOSUN_REMOVED=<n> and BOSUN_LOOKALIKE=<n> on success, or one of
 * BOSUN_NOFILE, BOSUN_NEWKEY_MISSING, BOSUN_RESTORED.
 */
export function pruneWindowsKeysScript(opts: { account: string; label: string; publicKey: string }): string {
    return `
$ErrorActionPreference = 'Stop'
$ak = Join-Path (Join-Path $env:ProgramData 'ssh') 'administrators_authorized_keys'
$key = ${psLiteral(opts.publicKey)}
$label = ${psLiteral(opts.label)}
$suffix = ${psLiteral(`-${opts.account}`)}
$body = ($key.Trim() -split '\\s+')[1]
if (-not (Test-Path $ak)) {
  Write-Output 'BOSUN_NOFILE'
} else {
  $lines = [System.IO.File]::ReadAllLines($ak)
  if (-not ($lines | Where-Object { $_.Contains($body) })) {
    Write-Output 'BOSUN_NEWKEY_MISSING'
  } else {
    $keep = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $lookalike = 0
    foreach ($l in $lines) {
      $t = $l.Trim()
      if ($t -ne '' -and -not $t.Contains($body)) {
        $last = ($t -split '\\s+')[-1]
        if ($last -ceq $label) { $removed++; continue }
        if ($last.EndsWith($suffix, [System.StringComparison]::Ordinal)) { $lookalike++; Write-Output ('BOSUN_CAND ' + ($t -split '\\s+')[1] + ' ' + $last) }
      }
      $keep.Add($l)
    }
    $ok = $true
    if ($removed -gt 0) {
      Copy-Item -Path $ak -Destination ($ak + '.bosun-bak') -Force
      [System.IO.File]::WriteAllLines($ak, $keep.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
      $verify = [System.IO.File]::ReadAllLines($ak)
      if (-not ($verify | Where-Object { $_.Contains($body) })) {
        Copy-Item -Path ($ak + '.bosun-bak') -Destination $ak -Force
        $ok = $false
        Write-Output 'BOSUN_RESTORED'
      }
    }
    if ($ok) {
      Write-Output ('BOSUN_REMOVED=' + $removed)
      Write-Output ('BOSUN_LOOKALIKE=' + $lookalike)
    }
  }
}
`.trim();
}
