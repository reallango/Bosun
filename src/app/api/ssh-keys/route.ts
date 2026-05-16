import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { rqlite } from '@/lib/db/rqlite-client';
import { encrypt, generateFingerprint } from '@/lib/crypto/keys';
import { logAudit, AuditActions } from '@/lib/audit/logger';

export async function GET(request: NextRequest) {
  try {
    const accessToken = request.cookies.get('access_token')?.value;
    if (!accessToken) {
      return NextResponse.json({ error: { message: 'Not authenticated', code: 'NOT_AUTHENTICATED' } }, { status: 401 });
    }

    const payload = await verifyAccessToken(accessToken);
    if (!payload || payload.role === 'viewer') {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, { status: 403 });
    }

    const result = await rqlite.query(
      `SELECT id, name, fingerprint, key_type, created_at, updated_at FROM ssh_keys ORDER BY name`
    );

    const keys = result.values.map(row => ({
      id: row[0], name: row[1], fingerprint: row[2], key_type: row[3], created_at: row[4], updated_at: row[5]
    }));

    return NextResponse.json({ data: keys });
  } catch (error) {
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

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

    const { name, private_key, public_key, passphrase } = await request.json();

    if (!name || !private_key || !public_key) {
      return NextResponse.json({ error: { message: 'Name, private_key, and public_key are required', code: 'INVALID_INPUT' } }, { status: 400 });
    }

    const masterKey = process.env.MASTER_KEY;
    if (!masterKey) {
      return NextResponse.json({ error: { message: 'MASTER_KEY not configured', code: 'NOT_CONFIGURED' } }, { status: 500 });
    }

    const encryptedPrivateKey = encrypt(private_key, masterKey);
    const encryptedPassphrase = passphrase ? encrypt(passphrase, masterKey) : null;
    const fingerprint = generateFingerprint(public_key);

    const result = await rqlite.execute(
      `INSERT INTO ssh_keys (name, public_key, private_key_enc, passphrase_enc, fingerprint, key_type) VALUES (?, ?, ?, ?, ?, 'ed25519')`,
      [name, public_key, encryptedPrivateKey, encryptedPassphrase, fingerprint]
    );

    await logAudit({
      userId: payload.userId,
      action: AuditActions.SSH_KEY_CREATE,
      status: 'success',
      details: `Created key: ${name}`
    });

    return NextResponse.json({ data: { id: result.last_insert_id, name, fingerprint } }, { status: 201 });
  } catch (error) {
    console.error('SSH key create error:', error);
    return NextResponse.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}