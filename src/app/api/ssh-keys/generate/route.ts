import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { encrypt } from '@/lib/crypto/keys';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import { generateSSHKeyPair } from '@/lib/ssh/keygen';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });

    const { name: bodyName } = await request.json().catch(() => ({}));
    const keyName = bodyName || `bosun-${Date.now()}`;

    // Generate key using ssh-keygen (produces OpenSSH format)
    const { privateKey, publicKey, fingerprint } = generateSSHKeyPair(keyName, 'ed25519');

    const mk = process.env.MASTER_KEY || '';
    const enc = encrypt(privateKey, mk);

    const id = crypto.randomUUID();
    await rqlite.execute(
      "INSERT INTO ssh_keys (id,name,public_key,private_key_enc,fingerprint,key_type) VALUES (?,?,?,?,?,'ed25519')",
      [id, keyName, publicKey, enc, fingerprint]
    );
    await logAudit({ userId: payload.userId, action: AuditActions.SSH_KEY_CREATE, status: 'success', details: `Generated: ${keyName}` });

    // Return private key only once (for user to download)
    return NextResponse.json({
      data: { id, name: keyName, public_key: publicKey, private_key: privateKey, fingerprint }
    }, { status: 201 });
  } catch (error) {
    console.error('Key generate error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}