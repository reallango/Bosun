import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/middleware';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { powershellCommand } from '@/lib/collect/windows';
import { pruneWindowsKeysScript } from '@/lib/ssh/windows-keys';
import { linuxPruneScript, linuxRemoveScript, windowsRemoveScript, parseCandidates, keyBody } from '@/lib/ssh/key-cleanup';
import { sshExec, stripSudo, asRootCommand, type SshAuth } from '@/lib/ssh/admin-exec';

const SERVICE_ACCOUNT_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,19}$/;

/**
 * Remove chosen leftover keys from a host after provisioning.
 *
 * Provisioning lists keys that look like an earlier Bosun's (`...-<account>`) but are not labeled for
 * this host, and leaves them alone. This endpoint removes the ones the person picked, by fingerprint.
 * It takes the administrator login again (used for this one call, never stored), looks the candidates
 * up on the host itself, and only ever removes keys from that list: never the host's new key, never an
 * unrelated key. A backup is saved next to the file, and the change is undone if the new key would be lost.
 *
 * Body: { hostname, port?, admin_username, admin_password, platform, service_account, keep_key_id, fingerprints: [...] }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck) return roleCheck;

  const bad = (message: string, status = 400, code = 'VALIDATION_ERROR') => NextResponse.json({ error: { message, code } }, { status });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return bad('Invalid JSON body'); }
  const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
  const port = Number(body.port) || 22;
  const adminUser = typeof body.admin_username === 'string' ? body.admin_username : '';
  const adminPassword = typeof body.admin_password === 'string' ? body.admin_password : '';
  const platform = body.platform === 'windows' ? 'windows' : 'linux';
  const account = typeof body.service_account === 'string' ? body.service_account : '';
  const keepKeyId = typeof body.keep_key_id === 'string' ? body.keep_key_id : '';
  const fingerprints = Array.isArray(body.fingerprints) ? body.fingerprints : null;
  if (!hostname || !adminUser || !adminPassword) return bad('hostname, admin_username and admin_password required');
  if (!SERVICE_ACCOUNT_RE.test(account)) return bad('service_account is not valid');
  if (!keepKeyId) return bad('keep_key_id required');
  if (!fingerprints || fingerprints.length > 50 || fingerprints.some(f => typeof f !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(f))) {
    return bad('fingerprints must be a list of up to 50 SHA256 fingerprints');
  }

  try {
    // The key Bosun keeps: the one it generated for this host. Its label must match, so this cannot be
    // pointed at some other key row.
    const label = `${hostname}-${account}`;
    const row = await rqlite.query('SELECT public_key FROM ssh_keys WHERE id = ? AND name = ?', [keepKeyId, label]);
    const publicKey = row.values?.[0]?.[0] as string | undefined;
    if (!publicKey || !keyBody(publicKey)) return bad('The host\'s Bosun key was not found', 404, 'NOT_FOUND');

    const ssh: SshAuth = { host: hostname, port, username: adminUser, password: adminPassword };
    try {
      await sshExec(ssh, platform === 'windows' ? powershellCommand('Write-Output connected') : 'echo connected');
    } catch (err) {
      return bad(`Cannot connect: ${String(err)}`, 400, 'SSH_CONNECT_FAILED');
    }

    // Look the candidates up again on the host (their current state, not what the browser remembers).
    const listed = platform === 'windows'
      ? await sshExec(ssh, powershellCommand(pruneWindowsKeysScript({ account, label, publicKey })))
      : await sshExec(ssh, asRootCommand(ssh, adminPassword, linuxPruneScript({ account, label, publicKey })));
    const candidates = parseCandidates(listed.stdout);
    const chosen = candidates.filter(c => (fingerprints as string[]).includes(c.fingerprint));
    if (chosen.length === 0) {
      return NextResponse.json({ data: { removed: 0, remaining: candidates.map(c => ({ fingerprint: c.fingerprint, comment: c.comment })) } });
    }

    const bodies = chosen.map(c => c.body);
    const removal = platform === 'windows'
      ? await sshExec(ssh, powershellCommand(windowsRemoveScript({ publicKey, bodies })))
      : await sshExec(ssh, asRootCommand(ssh, adminPassword, linuxRemoveScript({ account, publicKey, bodies })));
    const removed = removal.stdout.match(/BOSUN_REMOVED=(\d+)/);
    if (!removed) {
      const why = removal.stdout.includes('BOSUN_RESTORED') ? 'a safety check failed, so the original file was restored'
        : removal.stdout.includes('BOSUN_NEWKEY_MISSING') ? 'the host\'s Bosun key was not found in the file'
        : (stripSudo(removal.stderr) || removal.stdout.trim() || `exit ${removal.exitCode}`).slice(0, 200);
      await logAudit({ userId: auth.userId, action: AuditActions.SERVER_PROVISION_KEYS, status: 'failure', details: `${hostname}: ${why}` });
      return bad(`The keys were not removed: ${why}`, 502, 'KEY_REMOVE_FAILED');
    }

    const n = Number(removed[1]);
    await logAudit({
      userId: auth.userId, action: AuditActions.SERVER_PROVISION_KEYS, status: 'success',
      details: JSON.stringify({ host: hostname, account, removed: n, fingerprints: chosen.map(c => c.fingerprint), comments: chosen.map(c => c.comment) }).slice(0, 900),
    });
    const gone = new Set(chosen.map(c => c.fingerprint));
    return NextResponse.json({ data: { removed: n, remaining: candidates.filter(c => !gone.has(c.fingerprint)).map(c => ({ fingerprint: c.fingerprint, comment: c.comment })) } });
  } catch (error) {
    console.error('Key cleanup error:', error);
    return bad(String(error), 500, 'KEY_CLEANUP_ERROR');
  }
}
