import { apiKeyState, type ApiKeyState } from './api-keys';

/** Columns of api_keys (alias `k`) safe to return: never key_hash. */
export const API_KEY_COLUMNS =
  'k.id, k.name, k.key_prefix, k.role, k.created_by, k.created_at, k.last_used_at, k.last_used_ip, k.expires_at, k.revoked_at';

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  role: string;
  created_by: string | null;
  created_by_username: string | null;
  created_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  status: ApiKeyState;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function toApiKeyDto(row: Record<string, unknown>, now = Date.now()): ApiKeyDto {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.key_prefix),
    role: String(row.role),
    created_by: str(row.created_by),
    created_by_username: str(row.created_by_username),
    created_at: str(row.created_at),
    last_used_at: str(row.last_used_at),
    last_used_ip: str(row.last_used_ip),
    expires_at: str(row.expires_at),
    revoked_at: str(row.revoked_at),
    status: apiKeyState(row, now),
  };
}
