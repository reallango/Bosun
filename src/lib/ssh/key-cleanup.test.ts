import { describe, it, expect } from 'vitest';
import { keyBody, fingerprintOfBody, parseCandidates, linuxPruneScript, linuxRemoveScript, windowsRemoveScript, KEY_BODY_RE } from './key-cleanup';

const NEW = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhW4ikJ72vHkC8a9beWDcdzBCPrwoEn1i1HswXb+6L3 host-bosun-svc';
const OLD = 'AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOld12';

describe('key helpers', () => {
  it('extracts the key blob and computes ssh-keygen style fingerprints', () => {
    expect(keyBody(NEW)).toBe('AAAAC3NzaC1lZDI1NTE5AAAAIEhW4ikJ72vHkC8a9beWDcdzBCPrwoEn1i1HswXb+6L3');
    expect(keyBody('')).toBe('');
    expect(fingerprintOfBody(keyBody(NEW))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fingerprintOfBody(keyBody(NEW))).toBe(fingerprintOfBody(keyBody(NEW)));
    expect(fingerprintOfBody(OLD)).not.toBe(fingerprintOfBody(keyBody(NEW)));
  });

  it('only accepts base64 blobs, so nothing else can reach a script', () => {
    expect(KEY_BODY_RE.test(keyBody(NEW))).toBe(true);
    for (const bad of ["AAAA'; rm -rf / #AAAAAAAAAAAAAAAAAAAA", 'short', 'AAAA AAAA', 'AAAA\nAAAA', '$(id)AAAAAAAAAAAAAAAAAAAAAAAA']) expect(KEY_BODY_RE.test(bad), bad).toBe(false);
  });
});

describe('parseCandidates', () => {
  it('reads BOSUN_CAND lines, ignores noise and bad blobs, and removes duplicates', () => {
    const out = `BOSUN_REMOVED=1\nBOSUN_CAND ${OLD} oldhost-bosun-svc\nBOSUN_CAND ${OLD} oldhost-bosun-svc\nBOSUN_CAND bad;blob x-bosun-svc\nsome other line\r\nBOSUN_CAND ${keyBody(NEW)} another-bosun-svc\r\n`;
    const c = parseCandidates(out);
    expect(c.map(x => x.comment)).toEqual(['oldhost-bosun-svc', 'another-bosun-svc']);
    expect(c[0].fingerprint).toBe(fingerprintOfBody(OLD));
  });
});

describe('scripts', () => {
  it('Linux prune removes only the exact label and lists the other look-alikes without touching them', () => {
    const s = linuxPruneScript({ account: 'bosun-svc', label: 'host-bosun-svc', publicKey: NEW });
    expect(s).toContain('$NF == label');                 // exact label, not a suffix
    expect(s).toContain('BOSUN_CAND');
    expect(s).toContain('cp -p "$ak" "$ak.bosun-bak"'); // backup before rewriting
    expect(s.indexOf('grep -qF -- "$BODY" "$tmp"')).toBeLessThan(s.indexOf('cat "$tmp" > "$ak"'));   // new key checked first
  });

  it('Linux removal removes only the listed blobs, never the new key, and checks the new key survives', () => {
    const s = linuxRemoveScript({ account: 'bosun-svc', publicKey: NEW, bodies: [OLD, "x'; reboot #"] });
    expect(s).toContain(OLD);
    expect(s).not.toContain('reboot');                  // anything that is not a base64 blob is dropped
    expect(s).toContain('index($0, keep) == 0');
    expect(s).toContain('exit 2');
    expect(s).toContain('.bosun-bak');
  });

  it('Windows removal lists only valid blobs, protects the new key, backs up and restores', () => {
    const s = windowsRemoveScript({ publicKey: NEW, bodies: [OLD, 'x; Remove-Item C:\ #'] });
    expect(s).toContain(`'${OLD}'`);
    expect(s).not.toContain('Remove-Item C:');
    expect(s).toContain('-not $l.Contains($keep)');
    expect(s).toContain('BOSUN_RESTORED');
    expect(s).toContain('.bosun-bak');
    expect(/^[\x00-\x7f]*$/.test(s)).toBe(true);
  });
});
