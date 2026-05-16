import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { encrypt, generateFingerprint } from '@/lib/crypto/keys';
import { logAudit, AuditActions } from '@/lib/audit/logger';
import crypto from 'crypto';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const result = await rqlite.query('SELECT id, name, fingerprint, key_type, created_at FROM ssh_keys ORDER BY name');
    return NextResponse.json({ data: rowsToObjects(result) });
  } catch (error) {
    console.error('SSH keys error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) return NextResponse.json({ error: { message: 'Not authenticated' } }, { status: 401 });
    const payload = await verifyAccessToken(accessToken);
    if (!payload) return NextResponse.json({ error: { message: 'Invalid token' } }, { status: 401 });
    const { name, public_key, private_key, passphrase } = await request.json();
    if (!name||!public_key||!private_key) return NextResponse.json({ error: { message: 'name, public_key, private_key required' } }, { status: 400 });
    const mk = process.env.MASTER_KEY || '';
    const enc = encrypt(private_key, mk);
    const ppEnc = passphrase ? encrypt(passphrase, mk) : null;
    const fp = generateFingerprint(public_key);
    const id = crypto.randomUUID();
    await rqlite.execute("INSERT INTO ssh_keys (id,name,public_key,private_key_enc,passphrase_enc,fingerprint,key_type) VALUES (?,?,?,?,?,?,'ed25519')", [id, name, public_key, enc, ppEnc, fp]);
    await logAudit({ userId: payload.userId, action: AuditActions.SSH_KEY_CREATE, status: 'success', details: name });
    return NextResponse.json({ data: { id, name, fingerprint: fp, key_type: 'ed25519' } }, { status: 201 });
  } catch (error) {
    console.error('SSH key create error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}