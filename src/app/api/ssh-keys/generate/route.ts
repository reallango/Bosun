import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });
    }

    // Generate new Ed25519 key pair
    const { generateKeyPairSync } = await import('crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    const publicKeyPEM = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

    const fingerprint = generateFingerprint(publicKeyPEM);

    const result = await rqlite.execute(
      `INSERT INTO ssh_keys (name, public_key, private_key_enc, fingerprint, key_type) VALUES (?, ?, ?, ?, 'ed25519')`,
      ['Generated Key', publicKeyPEM, privateKeyPEM, fingerprint]
    );

    await logAudit({
      userId: payload.userId,
      action: AuditActions.SSH_KEY_CREATE,
      status: 'success',
      details: `Generated new key`
    });

    return NextResponse.json({
      data: {
        id: result.last_insert_id,
        fingerprint,
        private_key: privateKeyPEM,
        public_key: publicKeyPEM
      }
    });
  } catch (error) {
    console.error('Key generate error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

function generateFingerprint(publicKey: string): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(publicKey.trim());
  const digest = hash.digest('base64');
  return 'SHA256:' + digest.replace(/=+$/, '');
}