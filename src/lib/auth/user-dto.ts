/** Columns safe to return (never password hashes, TOTP seeds or backup codes). */
export const USER_COLUMNS =
  'id, username, display_name, email, role, disabled, mfa_method, last_login, password_changed_at, created_at, updated_at';

export interface UserDto {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
  disabled: boolean;
  mfa_method: string;
  last_login: string | null;
  password_changed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function toUserDto(row: Record<string, unknown>): UserDto {
  return {
    id: String(row.id),
    username: String(row.username),
    display_name: str(row.display_name),
    email: str(row.email),
    role: String(row.role),
    disabled: Number(row.disabled) === 1,
    mfa_method: str(row.mfa_method) || 'none',
    last_login: str(row.last_login),
    password_changed_at: str(row.password_changed_at),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
  };
}
