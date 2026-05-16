import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { encrypt, generateFingerprint as generateFp } from '@/lib/crypto/keys';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { generateKeyPairSync } = crypto;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const mk = process.env.MASTER_KEY || '';
    const enc = encrypt(privateKey, mk);
    const fp = generateFp(publicKey);
    const id = crypto.randomUUID();
    const name = `bosun-${Date.now()}`;
    await rqlite.execute("INSERT INTO ssh_keys (id,name,public_key,private_key_enc,fingerprint,key_type) VALUES (?,?,?,?,?,'ed25519')", [id, name, publicKey, enc, fp]);
    await logAudit({ userId: payload.userId, action: AuditActions.SSH_KEY_CREATE, status: 'success', details: `Generated: ${name}` });
    return NextResponse.json({ data: { id, name, public_key: publicKey, private_key: privateKey, fingerprint: fp } }, { status: 201 });
  } catch (error) {
    console.error('Key generate error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}