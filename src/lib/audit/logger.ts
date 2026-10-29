import crypto from 'crypto';
import { rqlite } from '../db/rqlite-client';

export interface AuditLogEntry {
  userId?: string;
  serverId?: string;
  action: string;
  category?: string;
  details?: string;
  status: 'success' | 'failure' | 'pending' | 'cancelled';
  ipAddress?: string;
  durationMs?: number;
}

/**
 * Append an audit record. Never throws: a failed audit write is logged but
 * must not fail the action being audited.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    await rqlite.execute(
      `INSERT INTO audit_log (id, user_id, server_id, action, category, details, status, ip_address, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        entry.userId || null,
        entry.serverId || null,
        entry.action,
        entry.category || entry.action.split('.')[0] || 'general',
        entry.details || null,
        entry.status,
        entry.ipAddress || null,
        entry.durationMs ?? null
      ]
    );
  } catch (err) {
    console.error('Audit log write failed:', err);
  }
}

export const AuditActions = {
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  LOGIN_FAILED: 'auth.login_failed',
  SERVER_CREATE: 'server.create',
  SERVER_UPDATE: 'server.update',
  SERVER_DELETE: 'server.delete',
  SERVER_TEST: 'server.test',
  SERVER_DETECT: 'server.detect',
  SERVER_WAKE: 'server.wake',
  SERVER_WOL_INSTALL: 'server.wol_install',
  SSH_KEY_CREATE: 'ssh_key.create',
  SSH_KEY_DELETE: 'ssh_key.delete',
  CONFIG_UPDATE: 'config.update',
  CONTAINER_ACTION: 'docker.container_action',
  OLLAMA_PULL: 'ollama.pull',
  OLLAMA_DELETE: 'ollama.delete',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DISABLE: 'user.disable',
  USER_ENABLE: 'user.enable',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_DELETE: 'user.delete',
  API_KEY_CREATE: 'api_key.create',
  API_KEY_REVOKE: 'api_key.revoke',
  API_KEY_DELETE: 'api_key.delete',
  SERVER_EXEC: 'server.exec',
  SERVER_POWER: 'server.power',
  PERMISSION_GROUP_CREATE: 'permission_group.create',
  PERMISSION_GROUP_UPDATE: 'permission_group.update',
  PERMISSION_GROUP_DELETE: 'permission_group.delete',
  SERVER_GROUP_CREATE: 'server_group.create',
  SERVER_GROUP_UPDATE: 'server_group.update',
  SERVER_GROUP_DELETE: 'server_group.delete',
  ACCESS_GROUPS_SET: 'access.groups_set',
} as const;
