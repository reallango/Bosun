export interface User {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: 'admin' | 'operator' | 'viewer';
  totp_enabled: boolean;
  preferences: Record<string, unknown>;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface SetupInput {
  username: string;
  password: string;
  email?: string;
}

export interface AuthResponse {
  user: Pick<User, 'id' | 'username' | 'role'>;
}

export interface TokenCookies {
  accessToken: string;
  refreshToken: string;
}