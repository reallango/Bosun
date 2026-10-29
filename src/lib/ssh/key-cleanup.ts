/**
 * Earlier Bosun keys on a host.
 *
 * When a host is provisioned again, keys labeled exactly `<host>-<account>` (the label Bosun gives
 * the key it generates for that host) are replaced automatically. Other keys that merely look like
 * Bosun's (`<anything>-<account>`, for example from an old install that used another host name) are
 * NOT touched: they are listed so the person can choose which to remove. The removal scripts here
 * only ever remove keys from that list, never the new key, and keep a backup.
 *
 * Pure strings and parsing so it can be unit tested.
 */
import crypto from 'crypto';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The base64 key blob a public key line carries (its second field). */
export function keyBody(publicKey: string): string {
  return (publicKey.trim().split(/\s+/)[1] || '').trim();
}

/** Base64 key blobs only: nothing else can end up inside a script. */
export const KEY_BODY_RE = /^[A-Za-z0-9+/]{20,2048}={0,2}$/;

/** `SHA256:...` fingerprint of a key blob, as `ssh-keygen -l` prints it. */
export function fingerprintOfBody(body: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export interface KeyCandidate {
  /** Fingerprint: how the person and the API refer to the key. */
  fingerprint: string;
  comment: string;
  /** The key blob (kept server side; the browser only needs fingerprint and comment). */
  body: string;
}

/** Parse the `BOSUN_CAND <body> <comment>` lines a listing script prints. */
export function parseCandidates(stdout: string): KeyCandidate[] {
  const out: KeyCandidate[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^BOSUN_CAND (\S+) (.*)$/);
    if (!m || !KEY_BODY_RE.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ body: m[1], comment: m[2].trim().slice(0, 120), fingerprint: fingerprintOfBody(m[1]) });
  }
  return out;
}

/**
 * Linux: remove keys labeled exactly `label` (except the new key) from the service account's
 * authorized_keys, then list the other `-<account>` keys without touching them. The file is never
 * rewritten without the new key in it. Prints BOSUN_REMOVED=<n> and BOSUN_CAND lines.
 */
export function linuxPruneScript(opts: { account: string; label: string; publicKey: string }): string {
  const body = keyBody(opts.publicKey);
  return `ak=/home/${opts.account}/.ssh/authorized_keys; BODY=${shq(body)}; LABEL=${shq(opts.label)}; SUF=${shq(`-${opts.account}`)}; `
    + `[ -f "$ak" ] || { echo BOSUN_REMOVED=0; exit 0; }; tmp=$(mktemp) || exit 1; `
    + `awk -v label="$LABEL" -v body="$BODY" '{ if ($NF == label && index($0, body) == 0) next; print }' "$ak" > "$tmp" || { rm -f "$tmp"; exit 1; }; `
    + `grep -qF -- "$BODY" "$tmp" || { rm -f "$tmp"; exit 2; }; `
    + `removed=$(( $(grep -c . "$ak") - $(grep -c . "$tmp") )); `
    + `if [ "$removed" -gt 0 ]; then cp -p "$ak" "$ak.bosun-bak" && cat "$tmp" > "$ak"; fi; rm -f "$tmp"; echo BOSUN_REMOVED=$removed; `
    + `awk -v suf="$SUF" -v body="$BODY" '{ n=length($NF); s=length(suf); if (NF >= 3 && n >= s && substr($NF, n-s+1) == suf && index($0, body) == 0) print "BOSUN_CAND " $2 " " $NF }' "$ak"`;
}

/**
 * Linux: remove exactly the keys whose blob is in `bodies` (and never the new key), after a backup.
 * Prints BOSUN_REMOVED=<n>; exit 2 when the new key would be missing afterwards (nothing is changed).
 */
export function linuxRemoveScript(opts: { account: string; publicKey: string; bodies: string[] }): string {
  const list = opts.bodies.filter(b => KEY_BODY_RE.test(b)).join(' ');
  return `ak=/home/${opts.account}/.ssh/authorized_keys; KEEP=${shq(keyBody(opts.publicKey))}; LIST=${shq(list)}; `
    + `[ -f "$ak" ] || { echo BOSUN_REMOVED=0; exit 0; }; tmp=$(mktemp) || exit 1; `
    + `awk -v keep="$KEEP" -v list="$LIST" 'BEGIN { n = split(list, a, " "); for (i = 1; i <= n; i++) rm[a[i]] = 1 } { if (index($0, keep) == 0 && ($2 in rm)) next; print }' "$ak" > "$tmp" || { rm -f "$tmp"; exit 1; }; `
    + `grep -qF -- "$KEEP" "$tmp" || { rm -f "$tmp"; exit 2; }; `
    + `removed=$(( $(grep -c . "$ak") - $(grep -c . "$tmp") )); `
    + `if [ "$removed" -gt 0 ]; then cp -p "$ak" "$ak.bosun-bak" && cat "$tmp" > "$ak"; fi; rm -f "$tmp"; echo BOSUN_REMOVED=$removed`;
}

/**
 * Windows: remove exactly the keys whose blob is in `bodies` from administrators_authorized_keys,
 * never the new key, after a backup copy; the backup is restored if the new key is not found afterwards.
 * Prints BOSUN_REMOVED=<n>, or BOSUN_NOFILE / BOSUN_NEWKEY_MISSING / BOSUN_RESTORED.
 */
export function windowsRemoveScript(opts: { publicKey: string; bodies: string[] }): string {
  const list = opts.bodies.filter(b => KEY_BODY_RE.test(b)).map(psq).join(',');
  return `
$ErrorActionPreference = 'Stop'
$ak = Join-Path (Join-Path $env:ProgramData 'ssh') 'administrators_authorized_keys'
$keep = ${psq(keyBody(opts.publicKey))}
$drop = @(${list})
if (-not (Test-Path $ak)) {
  Write-Output 'BOSUN_NOFILE'
} else {
  $lines = [System.IO.File]::ReadAllLines($ak)
  if (-not ($lines | Where-Object { $_.Contains($keep) })) {
    Write-Output 'BOSUN_NEWKEY_MISSING'
  } else {
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = 0
    foreach ($l in $lines) {
      $parts = $l.Trim() -split '\\s+'
      if ($parts.Count -ge 2 -and -not $l.Contains($keep) -and ($drop -ccontains $parts[1])) { $removed++; continue }
      $kept.Add($l)
    }
    $ok = $true
    if ($removed -gt 0) {
      Copy-Item -Path $ak -Destination ($ak + '.bosun-bak') -Force
      [System.IO.File]::WriteAllLines($ak, $kept.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
      if (-not ([System.IO.File]::ReadAllLines($ak) | Where-Object { $_.Contains($keep) })) {
        Copy-Item -Path ($ak + '.bosun-bak') -Destination $ak -Force
        $ok = $false
        Write-Output 'BOSUN_RESTORED'
      }
    }
    if ($ok) { Write-Output ('BOSUN_REMOVED=' + $removed) }
  }
}
`.trim();
}
